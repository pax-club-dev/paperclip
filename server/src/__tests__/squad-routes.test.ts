/**
 * Tests for Squad CRUD, membership, routing, and messaging routes.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { squadRoutes } from "../routes/squads.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const companyId = "22222222-2222-4222-8222-222222222222";
const squadId = "88888888-8888-4888-8888-888888888888";
const coordinatorId = "11111111-1111-4111-8111-111111111111";
const member1Id = "33333333-3333-4333-8333-333333333333";
const member2Id = "44444444-4444-4444-8444-444444444444";

const baseSquad = {
  id: squadId,
  companyId,
  name: "CTO",
  coordinatorAgentId: coordinatorId,
  routingPolicy: "round_robin",
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseMembers = [
  { id: coordinatorId, name: "CTO Alpha", role: "cto", status: "idle" },
  { id: member1Id, name: "Engineer 1", role: "engineer", status: "idle" },
  { id: member2Id, name: "Engineer 2", role: "engineer", status: "idle" },
];

const mockSquadService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getDetail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  postMessage: vi.fn(),
  listMessages: vi.fn(),
  routeMessage: vi.fn(),
  resolveByName: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  squadService: () => mockSquadService,
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function createApp(actor: Record<string, unknown> = { type: "board", userId: "user-1", source: "local_implicit" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", squadRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: Squad CRUD
// ---------------------------------------------------------------------------

describe("POST /companies/:companyId/squads", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.create.mockResolvedValue({
      ...baseSquad,
      members: baseMembers,
    });
  });

  it("creates a squad with members", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/squads`)
      .send({
        name: "CTO",
        coordinatorAgentId: coordinatorId,
        routingPolicy: "round_robin",
        memberAgentIds: [coordinatorId, member1Id, member2Id],
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("CTO");
    expect(res.body.members).toHaveLength(3);
    expect(mockSquadService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        name: "CTO",
        routingPolicy: "round_robin",
        memberAgentIds: [coordinatorId, member1Id, member2Id],
      }),
    );
  });

  it("logs activity when creating a squad", async () => {
    await request(app)
      .post(`/api/companies/${companyId}/squads`)
      .send({ name: "CTO" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "squad.created",
        entityType: "squad",
      }),
    );
  });

  it("validates required name field", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/squads`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("validates routing policy enum", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/squads`)
      .send({ name: "CTO", routingPolicy: "invalid_policy" });

    expect(res.status).toBe(400);
  });
});

describe("GET /companies/:companyId/squads", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("lists all squads for a company", async () => {
    mockSquadService.list.mockResolvedValue([
      { ...baseSquad, memberCount: 3, members: baseMembers },
    ]);

    const res = await request(app).get(`/api/companies/${companyId}/squads`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("CTO");
    expect(res.body[0].memberCount).toBe(3);
  });
});

describe("GET /squads/:id", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("returns squad with members", async () => {
    mockSquadService.getDetail.mockResolvedValue({
      ...baseSquad,
      members: baseMembers,
    });

    const res = await request(app).get(`/api/squads/${squadId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(squadId);
    expect(res.body.members).toHaveLength(3);
  });

  it("returns 404 if squad not found", async () => {
    mockSquadService.getDetail.mockResolvedValue(null);

    const res = await request(app).get(`/api/squads/${squadId}`);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /squads/:id", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
    mockSquadService.update.mockResolvedValue({
      ...baseSquad,
      routingPolicy: "broadcast",
      members: baseMembers,
    });
  });

  it("updates squad routing policy", async () => {
    const res = await request(app)
      .patch(`/api/squads/${squadId}`)
      .send({ routingPolicy: "broadcast" });

    expect(res.status).toBe(200);
    expect(res.body.routingPolicy).toBe("broadcast");
  });

  it("returns 404 if squad not found", async () => {
    mockSquadService.getById.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/squads/${squadId}`)
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /squads/:id", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
    mockSquadService.remove.mockResolvedValue(baseSquad);
  });

  it("deletes a squad", async () => {
    const res = await request(app).delete(`/api/squads/${squadId}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSquadService.remove).toHaveBeenCalledWith(squadId);
  });

  it("logs activity when deleting", async () => {
    await request(app).delete(`/api/squads/${squadId}`);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "squad.deleted",
        entityId: squadId,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Membership
// ---------------------------------------------------------------------------

describe("POST /squads/:id/members/:agentId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
    mockSquadService.addMember.mockResolvedValue(baseMembers);
  });

  it("adds a member to the squad", async () => {
    const res = await request(app)
      .post(`/api/squads/${squadId}/members/${member1Id}`);

    expect(res.status).toBe(200);
    expect(mockSquadService.addMember).toHaveBeenCalledWith(squadId, member1Id);
  });
});

describe("DELETE /squads/:id/members/:agentId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
    mockSquadService.removeMember.mockResolvedValue(baseMembers.slice(0, 2));
  });

  it("removes a member from the squad", async () => {
    const res = await request(app)
      .delete(`/api/squads/${squadId}/members/${member2Id}`);

    expect(res.status).toBe(200);
    expect(mockSquadService.removeMember).toHaveBeenCalledWith(squadId, member2Id);
  });
});

// ---------------------------------------------------------------------------
// Tests: Routing
// ---------------------------------------------------------------------------

describe("POST /squads/:id/route", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
  });

  it("routes to a single agent with round_robin", async () => {
    mockSquadService.routeMessage.mockResolvedValue([member1Id]);

    const res = await request(app).post(`/api/squads/${squadId}/route`);

    expect(res.status).toBe(200);
    expect(res.body.agentIds).toEqual([member1Id]);
  });

  it("routes to all members with broadcast", async () => {
    mockSquadService.routeMessage.mockResolvedValue([coordinatorId, member1Id, member2Id]);

    const res = await request(app).post(`/api/squads/${squadId}/route`);

    expect(res.status).toBe(200);
    expect(res.body.agentIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: Squad Messages
// ---------------------------------------------------------------------------

describe("POST /squads/:id/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSquadService.getById.mockResolvedValue(baseSquad);
  });

  it("agents can post squad messages", async () => {
    const agentApp = createApp({
      type: "agent",
      agentId: coordinatorId,
      companyId,
    });
    mockSquadService.postMessage.mockResolvedValue({
      id: "msg-1",
      squadId,
      fromAgentId: coordinatorId,
      content: "Task delegation update",
      createdAt: new Date(),
    });

    const res = await request(agentApp)
      .post(`/api/squads/${squadId}/messages`)
      .send({ content: "Task delegation update" });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe("Task delegation update");
  });

  it("rejects empty message content", async () => {
    const agentApp = createApp({
      type: "agent",
      agentId: coordinatorId,
      companyId,
    });

    const res = await request(agentApp)
      .post(`/api/squads/${squadId}/messages`)
      .send({ content: "" });

    expect(res.status).toBe(400);
  });

  it("rejects non-agent message posts", async () => {
    const boardApp = createApp({ type: "board", userId: "user-1" });

    const res = await request(boardApp)
      .post(`/api/squads/${squadId}/messages`)
      .send({ content: "hello" });

    expect(res.status).toBe(403);
  });
});

describe("GET /squads/:id/messages", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockSquadService.getById.mockResolvedValue(baseSquad);
    mockSquadService.listMessages.mockResolvedValue([
      { id: "msg-1", squadId, fromAgentId: coordinatorId, content: "Update", createdAt: new Date() },
    ]);
  });

  it("lists squad messages", async () => {
    const res = await request(app).get(`/api/squads/${squadId}/messages`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: @-mention resolution
// ---------------------------------------------------------------------------

describe("GET /companies/:companyId/squads/resolve", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("resolves a squad by name", async () => {
    mockSquadService.resolveByName.mockResolvedValue(baseSquad);
    mockSquadService.getDetail.mockResolvedValue({
      ...baseSquad,
      members: baseMembers,
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/squads/resolve?name=CTO`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("CTO");
    expect(res.body.members).toHaveLength(3);
  });

  it("returns 404 for unknown squad name", async () => {
    mockSquadService.resolveByName.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/companies/${companyId}/squads/resolve?name=Unknown`);

    expect(res.status).toBe(404);
  });

  it("requires name parameter", async () => {
    const res = await request(app)
      .get(`/api/companies/${companyId}/squads/resolve`);

    expect(res.status).toBe(400);
  });
});
