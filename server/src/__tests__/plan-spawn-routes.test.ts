/**
 * Tests for Plan Spawn routes: temp spawning, clone spawning, merge, lifecycle.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const companyId = "22222222-2222-4222-8222-222222222222";
const parentAgentId = "11111111-1111-4111-8111-111111111111";
const tempAgentId = "33333333-3333-4333-8333-333333333333";
const cloneAgentId = "44444444-4444-4444-8444-444444444444";
const mergeRequestId = "55555555-5555-4555-8555-555555555555";

const baseAgent = {
  id: parentAgentId,
  companyId,
  name: "PAX.CEO",
  urlKey: "pax-ceo",
  role: "ceo",
  title: "CEO",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: { env: {} },
  runtimeConfig: {},
  budgetMonthlyCents: 5000,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true },
  lastHeartbeatAt: null,
  metadata: null,
  lifecycleMode: "persistent",
  parentAgentId: null,
  spawnKind: null,
  spawnTaskId: null,
  terminateOnComplete: false,
  mergeTargetAgentId: null,
  squadId: null,
  spawnedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const tempAgent = {
  ...baseAgent,
  id: tempAgentId,
  name: "temp-worker-1",
  urlKey: "temp-worker-1",
  role: "engineer",
  lifecycleMode: "temp",
  parentAgentId,
  spawnKind: "temp",
  terminateOnComplete: true,
  spawnedAt: new Date(),
};

const cloneAgent = {
  ...baseAgent,
  id: cloneAgentId,
  name: "PAX.CEO (clone)",
  urlKey: "pax-ceo-clone",
  lifecycleMode: "temp",
  parentAgentId,
  spawnKind: "clone",
  terminateOnComplete: true,
  mergeTargetAgentId: parentAgentId,
  spawnedAt: new Date(),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  orgForCompany: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  runningForAgent: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  activatePendingApproval: vi.fn(),
  spawnTemp: vi.fn(),
  countActiveTemps: vi.fn(),
  listStaleTemps: vi.fn(),
  spawnClone: vi.fn(),
  listPendingMerges: vi.fn(),
  executeMerge: vi.fn(),
  cancelMerge: vi.fn(),
  getMergeRequest: vi.fn(),
  listMergeRequestsForClone: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  invoke: vi.fn(),
  wakeup: vi.fn(),
  cancelRun: vi.fn(),
  cancelActiveForAgent: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  tickTimers: vi.fn(),
  reapOrphanedRuns: vi.fn(),
  resumeQueuedRuns: vi.fn(),
  reapStaleTemps: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn((_, config) => config),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  checkPending: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  checkPending: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
  resolveDesiredSkillAssignment: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  updateBundle: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
}));

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runClaudeLogin: vi.fn(),
  };
});

vi.mock("@paperclipai/adapter-codex-local", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock("@paperclipai/adapter-cursor-local", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock("@paperclipai/adapter-gemini-local", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock("@paperclipai/adapter-opencode-local/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
  };
});

vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: vi.fn(),
  resolveDefaultAgentInstructionsBundleRole: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readPaperclipSkillSyncPreference: vi.fn(() => null),
    writePaperclipSkillSyncPreference: vi.fn((config: unknown) => config),
  };
});

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown> = { type: "board", userId: "user-1", source: "local_implicit" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: Temp Agent Spawning
// ---------------------------------------------------------------------------

describe("POST /agents/:id/spawn-temp", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.spawnTemp.mockResolvedValue(tempAgent);
  });

  it("spawns a temp agent from a parent", async () => {
    const res = await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-temp`)
      .send({ name: "temp-worker-1", role: "engineer" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(tempAgentId);
    expect(res.body.spawnKind).toBe("temp");
    expect(res.body.parentAgentId).toBe(parentAgentId);
    expect(mockAgentService.spawnTemp).toHaveBeenCalledWith(
      parentAgentId,
      expect.objectContaining({ name: "temp-worker-1", role: "engineer" }),
    );
  });

  it("logs activity when spawning a temp", async () => {
    await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-temp`)
      .send({ name: "temp-worker-1" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.spawned_temp",
        entityId: tempAgentId,
        details: expect.objectContaining({
          parentAgentId,
          tempName: "temp-worker-1",
        }),
      }),
    );
  });

  it("returns 404 if parent agent not found", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-temp`)
      .send({ name: "temp-worker-1" });

    expect(res.status).toBe(404);
    expect(mockAgentService.spawnTemp).not.toHaveBeenCalled();
  });

  it("validates required name field", async () => {
    const res = await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-temp`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("allows agents to spawn temps (no board restriction)", async () => {
    const agentApp = createApp({
      type: "agent",
      agentId: parentAgentId,
      companyId,
    });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.spawnTemp.mockResolvedValue(tempAgent);

    const res = await request(agentApp)
      .post(`/api/agents/${parentAgentId}/spawn-temp`)
      .send({ name: "temp-worker-1" });

    expect(res.status).toBe(201);
  });
});

describe("GET /agents/:id/temps", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
  });

  it("lists active temps for a parent", async () => {
    mockAgentService.list.mockResolvedValue([
      tempAgent,
      { ...tempAgent, id: "66666666-6666-4666-8666-666666666666", name: "temp-worker-2" },
      { ...baseAgent, spawnKind: null, parentAgentId: null }, // Not a temp
    ]);

    const res = await request(app).get(`/api/agents/${parentAgentId}/temps`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].spawnKind).toBe("temp");
  });

  it("returns 404 if parent not found", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(app).get(`/api/agents/${parentAgentId}/temps`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: Clone Spawning
// ---------------------------------------------------------------------------

describe("POST /agents/:id/spawn-clone", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.spawnClone.mockResolvedValue(cloneAgent);
  });

  it("spawns a clone of the parent agent", async () => {
    const res = await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-clone`)
      .send({ mergeStrategy: "append_summary" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(cloneAgentId);
    expect(res.body.spawnKind).toBe("clone");
    expect(res.body.mergeTargetAgentId).toBe(parentAgentId);
    expect(mockAgentService.spawnClone).toHaveBeenCalledWith(
      parentAgentId,
      expect.objectContaining({ mergeStrategy: "append_summary" }),
    );
  });

  it("logs activity when spawning a clone", async () => {
    await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-clone`)
      .send({});

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.spawned_clone",
        entityId: cloneAgentId,
        details: expect.objectContaining({
          parentAgentId,
          cloneName: "PAX.CEO (clone)",
        }),
      }),
    );
  });

  it("returns 404 if parent not found", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/agents/${parentAgentId}/spawn-clone`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe("GET /agents/:id/clones", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
  });

  it("lists clones including terminated ones", async () => {
    mockAgentService.list.mockResolvedValue([
      cloneAgent,
      { ...cloneAgent, id: "77777777-7777-4777-8777-777777777777", status: "terminated" },
    ]);

    const res = await request(app).get(`/api/agents/${parentAgentId}/clones`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Merge Requests
// ---------------------------------------------------------------------------

describe("merge request routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
  });

  describe("GET /agents/:id/merge-requests", () => {
    it("lists pending merge requests for target agent", async () => {
      mockAgentService.listPendingMerges.mockResolvedValue([
        {
          id: mergeRequestId,
          cloneAgentId,
          targetAgentId: parentAgentId,
          strategy: "append_summary",
          status: "pending",
          summary: null,
          errorMessage: null,
          createdAt: new Date(),
          resolvedAt: null,
        },
      ]);

      const res = await request(app).get(`/api/agents/${parentAgentId}/merge-requests`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe("pending");
    });
  });

  describe("POST /agents/:id/merge-requests/:mergeId/execute", () => {
    it("executes a merge and returns summary", async () => {
      mockAgentService.executeMerge.mockResolvedValue({
        status: "merged",
        summary: "Clone completed the task successfully.",
      });

      const res = await request(app)
        .post(`/api/agents/${parentAgentId}/merge-requests/${mergeRequestId}/execute`)
        .send({ summary: "Clone completed the task successfully." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("merged");
      expect(mockAgentService.executeMerge).toHaveBeenCalledWith(
        mergeRequestId,
        "Clone completed the task successfully.",
      );
    });

    it("logs activity after merge", async () => {
      mockAgentService.executeMerge.mockResolvedValue({
        status: "merged",
        summary: "Done.",
      });

      await request(app)
        .post(`/api/agents/${parentAgentId}/merge-requests/${mergeRequestId}/execute`)
        .send({});

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "agent.clone_merged",
          entityId: parentAgentId,
        }),
      );
    });
  });

  describe("POST /agents/:id/merge-requests/:mergeId/cancel", () => {
    it("cancels a pending merge request", async () => {
      mockAgentService.cancelMerge.mockResolvedValue({
        id: mergeRequestId,
        status: "cancelled",
        resolvedAt: new Date(),
      });

      const res = await request(app)
        .post(`/api/agents/${parentAgentId}/merge-requests/${mergeRequestId}/cancel`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
    });

    it("returns 404 if merge request not found or not pending", async () => {
      mockAgentService.cancelMerge.mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/agents/${parentAgentId}/merge-requests/${mergeRequestId}/cancel`)
        .send();

      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Lifecycle Mode via PATCH
// ---------------------------------------------------------------------------

describe("PATCH /agents/:id — lifecycle mode", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockResolvedValue({
      ...baseAgent,
      lifecycleMode: "always_on",
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
  });

  it("updates lifecycle mode to always_on", async () => {
    const res = await request(app)
      .patch(`/api/agents/${parentAgentId}`)
      .send({ lifecycleMode: "always_on" });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      parentAgentId,
      expect.objectContaining({ lifecycleMode: "always_on" }),
      expect.anything(),
    );
  });

  it("rejects invalid lifecycle mode", async () => {
    const res = await request(app)
      .patch(`/api/agents/${parentAgentId}`)
      .send({ lifecycleMode: "invalid_mode" });

    expect(res.status).toBe(400);
  });
});
