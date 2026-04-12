import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent readiness/wakeup tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent readiness gate, task wakeup, and stale-task detection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-readiness-wakeup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Use TRUNCATE CASCADE to handle complex FK chains created by heartbeatService
    await db.execute(sql`TRUNCATE
      issues,
      heartbeat_run_events,
      heartbeat_runs,
      agent_wakeup_requests,
      agent_task_sessions,
      agent_runtime_state,
      company_skills,
      agents,
      companies
      CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seed a company + agent, returning IDs and optional issue. */
  async function seedAgent(input?: {
    adapterType?: string;
    agentStatus?: string;
    adapterConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    lastHeartbeatAt?: Date | null;
    spawnKind?: string | null;
    lifecycleMode?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: input?.adapterType ?? "claude_local",
      adapterConfig: input?.adapterConfig ?? {
        model: "claude-opus-4-6",
        instructionsFilePath: "/path/to/AGENTS.md",
      },
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: { enabled: true, intervalSec: 1800 },
      },
      permissions: {},
      lastHeartbeatAt: input?.lastHeartbeatAt ?? null,
      spawnKind: input?.spawnKind ?? null,
      lifecycleMode: input?.lifecycleMode ?? "persistent",
    });

    return { companyId, agentId, issuePrefix };
  }

  /** Create an issue assigned to the given agent. */
  async function seedIssue(
    companyId: string,
    agentId: string,
    issuePrefix: string,
    overrides?: {
      status?: string;
      checkoutRunId?: string | null;
      executionRunId?: string | null;
    },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: overrides?.status ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      checkoutRunId: overrides?.checkoutRunId ?? null,
      executionRunId: overrides?.executionRunId ?? null,
    });
    return issueId;
  }

  // ─── 1. Agent Readiness Gate Tests ─────────────────────────────────────

  describe("agent readiness gate", () => {
    it("rejects wakeup for a paused agent", async () => {
      const { agentId } = await seedAgent({ agentStatus: "paused" });
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
        }),
      ).rejects.toThrow(/not invokable/i);
    });

    it("rejects wakeup for a terminated agent", async () => {
      const { agentId } = await seedAgent({ agentStatus: "terminated" });
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
        }),
      ).rejects.toThrow(/not invokable/i);
    });

    it("rejects wakeup for a pending_approval agent", async () => {
      const { agentId } = await seedAgent({ agentStatus: "pending_approval" });
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
        }),
      ).rejects.toThrow(/not invokable/i);
    });

    it("succeeds for an idle agent with valid config", async () => {
      const { companyId, agentId, issuePrefix } = await seedAgent({
        agentStatus: "idle",
        adapterConfig: {
          model: "claude-opus-4-6",
          instructionsFilePath: "/path/to/AGENTS.md",
        },
      });
      const issueId = await seedIssue(companyId, agentId, issuePrefix);
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId },
      });

      expect(run).toBeTruthy();

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs.some((r) => r.status === "queued" || r.status === "running")).toBe(true);
    });

    it("succeeds for an agent with empty adapterConfig when status is idle", async () => {
      const { companyId, agentId, issuePrefix } = await seedAgent({
        agentStatus: "idle",
        adapterConfig: {},
      });
      const issueId = await seedIssue(companyId, agentId, issuePrefix);
      const heartbeat = heartbeatService(db);

      // Empty adapter config is NOT currently a gate — the agent can still be woken.
      // This test documents current behavior: readiness validation happens at adapter
      // execution time, not at wakeup time.
      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId },
      });

      expect(run).toBeTruthy();
    });
  });

  // ─── 2. Task Wakeup Tests ─────────────────────────────────────────────

  describe("task wakeup on assignment", () => {
    it("queues a heartbeat run when an issue is assigned to an active agent", async () => {
      const { companyId, agentId, issuePrefix } = await seedAgent({ agentStatus: "idle" });
      const issueId = await seedIssue(companyId, agentId, issuePrefix);
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId },
      });

      expect(run).toBeTruthy();

      // Verify heartbeat run record was created
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBeGreaterThanOrEqual(1);

      const queuedRun = runs.find((r) => r.status === "queued" || r.status === "running");
      expect(queuedRun).toBeTruthy();
      expect(queuedRun!.invocationSource).toBe("assignment");
      expect(queuedRun!.triggerDetail).toBe("system");

      // Verify wakeup request record was created
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups.length).toBeGreaterThanOrEqual(1);
      expect(wakeups.some((w) => w.source === "assignment")).toBe(true);
    });

    it("does not queue a wakeup when issue has no assignee", async () => {
      const mockWakeup = vi.fn();
      const deps = { wakeup: mockWakeup };

      queueIssueAssignmentWakeup({
        heartbeat: deps,
        issue: { id: randomUUID(), assigneeAgentId: null, status: "todo" },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });

      expect(mockWakeup).not.toHaveBeenCalled();
    });

    it("does not queue a wakeup when issue status is backlog", async () => {
      const mockWakeup = vi.fn();
      const deps = { wakeup: mockWakeup };

      queueIssueAssignmentWakeup({
        heartbeat: deps,
        issue: { id: randomUUID(), assigneeAgentId: randomUUID(), status: "backlog" },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });

      expect(mockWakeup).not.toHaveBeenCalled();
    });

    it("queues a wakeup when issue has assignee and non-backlog status", async () => {
      const mockWakeup = vi.fn().mockResolvedValue(undefined);
      const deps = { wakeup: mockWakeup };
      const issueId = randomUUID();
      const agentId = randomUUID();

      queueIssueAssignmentWakeup({
        heartbeat: deps,
        issue: { id: issueId, assigneeAgentId: agentId, status: "todo" },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });

      expect(mockWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: expect.objectContaining({ issueId }),
      }));
    });

    it("skips wakeup when heartbeat wakeOnDemand is disabled", async () => {
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 1800, wakeOnDemand: false },
        },
      });
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
      });

      expect(run).toBeNull();

      // Verify a skipped wakeup request was recorded
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups.length).toBe(1);
      expect(wakeups[0]!.status).toBe("skipped");
    });
  });

  // ─── 3. Stale Task Detection Tests ────────────────────────────────────

  describe("stale task detection via reapOrphanedRuns", () => {
    it("reaps a running run with no tracked process and no in-memory handle", async () => {
      const { companyId, agentId, issuePrefix } = await seedAgent({
        adapterType: "claude_local",
        agentStatus: "idle",
      });
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const staleTime = new Date("2026-03-01T00:00:00.000Z");

      // Create issue first without run refs (FK requires run to exist first)
      const issueId = await seedIssue(companyId, agentId, issuePrefix, {
        status: "in_progress",
      });

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "claimed",
        runId,
        claimedAt: staleTime,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId,
        contextSnapshot: { issueId },
        processPid: null,
        processLossRetryCount: 0,
        startedAt: staleTime,
        updatedAt: staleTime,
      });

      // Now link the issue to the run
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, issueId));

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result.reaped).toBeGreaterThanOrEqual(1);
      expect(result.runIds).toContain(runId);

      // Verify run was marked failed
      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("process_lost");
    });

    it("does not reap a run that is still within the staleness threshold", async () => {
      const { companyId, agentId } = await seedAgent({
        adapterType: "claude_local",
        agentStatus: "idle",
      });
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const recentTime = new Date();

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        status: "claimed",
        runId,
        claimedAt: recentTime,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId,
        processPid: null,
        processLossRetryCount: 0,
        startedAt: recentTime,
        updatedAt: recentTime,
      });

      const heartbeat = heartbeatService(db);
      // Use a large staleness threshold — the run was just created so it's not stale
      const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60 * 60 * 1000 });

      expect(result.reaped).toBe(0);
    });

    it("does not reap queued runs (only running runs are orphan candidates)", async () => {
      const { companyId, agentId } = await seedAgent({ agentStatus: "idle" });
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        status: "claimed",
        runId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        processPid: null,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result.reaped).toBe(0);

      // Verify run is still queued
      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("queued");
    });
  });

  // ─── 4. Heartbeat Engagement Tests ────────────────────────────────────

  describe("heartbeat engagement via tickTimers", () => {
    it("enqueues a wakeup when the heartbeat interval has elapsed", async () => {
      const longAgo = new Date("2026-01-01T00:00:00.000Z");
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 1800 },
        },
        lastHeartbeatAt: longAgo,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(new Date("2026-04-01T00:00:00.000Z"));

      expect(result.enqueued).toBeGreaterThanOrEqual(1);

      // Verify a run was created for this agent
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs.some((r) => r.invocationSource === "timer")).toBe(true);
    });

    it("does not enqueue when the heartbeat interval has not elapsed", async () => {
      const recentTime = new Date("2026-04-01T00:00:00.000Z");
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 1800 },
        },
        lastHeartbeatAt: recentTime,
      });

      const heartbeat = heartbeatService(db);
      // 10 minutes later — well under the 1800s interval
      const result = await heartbeat.tickTimers(new Date("2026-04-01T00:10:00.000Z"));

      // Agent should not have been enqueued
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(0);
    });

    it("skips paused agents even if the interval has elapsed", async () => {
      const longAgo = new Date("2026-01-01T00:00:00.000Z");
      const { agentId } = await seedAgent({
        agentStatus: "paused",
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 1800 },
        },
        lastHeartbeatAt: longAgo,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(new Date("2026-04-01T00:00:00.000Z"));

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(0);
    });

    it("skips agents with heartbeat disabled", async () => {
      const longAgo = new Date("2026-01-01T00:00:00.000Z");
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        runtimeConfig: {
          heartbeat: { enabled: false, intervalSec: 1800 },
        },
        lastHeartbeatAt: longAgo,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.tickTimers(new Date("2026-04-01T00:00:00.000Z"));

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(0);
    });

    it("uses createdAt as baseline when lastHeartbeatAt is null", async () => {
      // Agent created long ago with no lastHeartbeatAt — interval should have elapsed
      const { companyId, agentId } = await seedAgent({
        agentStatus: "idle",
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 60 },
        },
        lastHeartbeatAt: null,
      });

      const heartbeat = heartbeatService(db);
      // Run tickTimers well after the agent's createdAt (which defaults to now)
      const futureTime = new Date(Date.now() + 120_000); // 2 minutes from now
      const result = await heartbeat.tickTimers(futureTime);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── 5. Stale Temp Agent Reaping ──────────────────────────────────────

  describe("reapStaleTemps", () => {
    it("terminates an idle temp agent that has been inactive beyond the threshold", async () => {
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        spawnKind: "temp",
        lifecycleMode: "ephemeral",
        lastHeartbeatAt: staleTime,
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.reapStaleTemps(60 * 60 * 1000); // 1 hour threshold

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      expect(agent?.status).toBe("terminated");
    });

    it("does not terminate a persistent agent even if idle", async () => {
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { agentId } = await seedAgent({
        agentStatus: "idle",
        spawnKind: null,
        lifecycleMode: "persistent",
        lastHeartbeatAt: staleTime,
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.reapStaleTemps(60 * 60 * 1000);

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      expect(agent?.status).toBe("idle");
    });
  });
});
