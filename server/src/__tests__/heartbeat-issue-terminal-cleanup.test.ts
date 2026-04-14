import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

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
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat terminal-issue cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat cleanup on terminal issue transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-terminal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix };
  }

  async function seedAgent(companyId: string, opts?: { status?: "idle" | "paused" | "running" }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TerminalCoder",
      role: "engineer",
      status: opts?.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(
    companyId: string,
    issuePrefix: string,
    issueNumber: number,
    opts: { status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled"; agentId?: string | null },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status: opts.status,
      priority: "medium",
      assigneeAgentId: opts.agentId ?? null,
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
    });
    return issueId;
  }

  async function seedQueuedRun(
    companyId: string,
    agentId: string,
    issueId: string | null,
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: issueId ? { issueId } : {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: issueId ? { issueId, source: "issue.status_change" } : {},
    });
    return { runId, wakeupRequestId };
  }

  describe("cancelQueuedRunsForIssue", () => {
    it("cancels all queued runs for the matching issueId", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "cancelled", agentId });
      const { runId: runA } = await seedQueuedRun(companyId, agentId, issueId);
      const { runId: runB } = await seedQueuedRun(companyId, agentId, issueId);

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.cancelQueuedRunsForIssue(issueId, "test");

      expect(result.cancelledCount).toBe(2);
      expect(new Set(result.runIds)).toEqual(new Set([runA, runB]));

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [runA, runB]));
      expect(runs.every((r) => r.status === "cancelled")).toBe(true);
      expect(runs.every((r) => r.errorCode === "cancelled")).toBe(true);
    });

    it("leaves queued runs for other issues untouched", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const targetAgentId = await seedAgent(companyId, { status: "paused" });
      const otherAgentId = await seedAgent(companyId, { status: "paused" });
      const targetIssueId = await seedIssue(companyId, issuePrefix, 1, { status: "cancelled", agentId: targetAgentId });
      const otherIssueId = await seedIssue(companyId, issuePrefix, 2, { status: "todo", agentId: otherAgentId });
      const { runId: targetRun } = await seedQueuedRun(companyId, targetAgentId, targetIssueId);
      const { runId: otherRun } = await seedQueuedRun(companyId, otherAgentId, otherIssueId);

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.cancelQueuedRunsForIssue(targetIssueId, "test");

      expect(result.cancelledCount).toBe(1);
      expect(result.runIds).toEqual([targetRun]);

      const preservedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, otherRun))
        .then((rows) => rows[0]);
      expect(preservedRun?.status).toBe("queued");
      expect(preservedRun?.errorCode).toBeNull();
    });

    it("is a no-op when there are no queued runs for the issue", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "cancelled", agentId });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.cancelQueuedRunsForIssue(issueId, "test");

      expect(result.cancelledCount).toBe(0);
      expect(result.runIds).toEqual([]);
    });

    it("does not touch runs that are already running (only queued)", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "cancelled", agentId });

      const runningRunId = randomUUID();
      const runningWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: runningWakeupId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: { issueId },
        status: "claimed",
        runId: runningRunId,
        claimedAt: new Date(),
      });
      await db.insert(heartbeatRuns).values({
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId: runningWakeupId,
        contextSnapshot: { issueId },
        startedAt: new Date(),
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.cancelQueuedRunsForIssue(issueId, "test");

      expect(result.cancelledCount).toBe(0);

      const stillRunning = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runningRunId))
        .then((rows) => rows[0]);
      expect(stillRunning?.status).toBe("running");
    });
  });

  describe("claimQueuedRun pre-execution safety check", () => {
    it("short-circuits a queued run whose target issue is already cancelled", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "cancelled", agentId });
      const { runId } = await seedQueuedRun(companyId, agentId, issueId);

      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();

      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("cancelled");
      expect(run?.error).toContain("cancelled");
    });

    it("short-circuits a queued run whose target issue is already done", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "done", agentId });
      const { runId } = await seedQueuedRun(companyId, agentId, issueId);

      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();

      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.error).toContain("done");
    });

    it("does NOT short-circuit a queued run whose target issue is still open", async () => {
      const { companyId, issuePrefix } = await seedCompany();
      const agentId = await seedAgent(companyId, { status: "paused" });
      const issueId = await seedIssue(companyId, issuePrefix, 1, { status: "todo", agentId });
      const { runId } = await seedQueuedRun(companyId, agentId, issueId);

      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();

      // Agent is paused, so startNextQueuedRunForAgent early-returns without invoking
      // claimQueuedRun. The critical assertion is that the run was NOT cancelled with the
      // "target issue is already ..." reason from the new safety check.
      const run = await heartbeat.getRun(runId);
      expect(run?.error ?? "").not.toMatch(/target issue .* is already/i);
    });
  });
});
