import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  stats: vi.fn(),
  listEnvironments: vi.fn(),
  cloneToEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  importBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockPortabilityService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
      ...actorOverrides,
    };
    next();
  });
  app.use("/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company environment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /companies/environments", () => {
    it("returns the list of environments", async () => {
      mockCompanyService.listEnvironments.mockResolvedValue(["production", "test-1", "test-2"]);

      const res = await request(createApp()).get("/companies/environments");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(["production", "test-1", "test-2"]);
      expect(mockCompanyService.listEnvironments).toHaveBeenCalledOnce();
    });

    it("requires board authentication", async () => {
      const app = createApp({ type: "agent", agentId: "agent-1" });
      const res = await request(app).get("/companies/environments");

      expect(res.status).toBe(403);
    });
  });

  describe("GET /companies with environment filter", () => {
    const allCompanies = [
      { id: "prod-1", name: "Acme", environment: "production", status: "active" },
      { id: "prod-2", name: "Beta", environment: "production", status: "active" },
      { id: "test-1a", name: "Acme [test-1]", environment: "test-1", status: "active" },
      { id: "test-2a", name: "Acme [test-2]", environment: "test-2", status: "active" },
    ];

    it("returns all companies when no environment filter", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
    });

    it("filters to production companies only", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies?environment=production");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.every((c: any) => c.environment === "production")).toBe(true);
    });

    it("filters to test-1 companies only", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies?environment=test-1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("test-1a");
    });

    it("returns empty array for environment with no companies", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies?environment=test-99");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("ignores empty environment param", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies?environment=");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
    });

    it("does not leak test companies when filtering for production", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const res = await request(createApp()).get("/companies?environment=production");
      const testCompanies = res.body.filter((c: any) => c.environment !== "production");
      expect(testCompanies).toHaveLength(0);
    });

    it("applies both environment filter and access control", async () => {
      mockCompanyService.list.mockResolvedValue(allCompanies);
      const app = createApp({
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["prod-1", "test-1a"],
      });
      const res = await request(app).get("/companies?environment=production");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("prod-1");
    });
  });

  describe("POST /companies/:companyId/clone-to-environment", () => {
    it("clones a company to a test environment", async () => {
      const clonedCompany = {
        id: "company-2",
        name: "Test Corp [test-1]",
        environment: "test-1",
        sourceCompanyId: "company-1",
      };
      mockCompanyService.cloneToEnvironment.mockResolvedValue(clonedCompany);
      mockAccessService.ensureMembership.mockResolvedValue(undefined);
      mockLogActivity.mockResolvedValue(undefined);

      const res = await request(createApp())
        .post("/companies/company-1/clone-to-environment")
        .send({ environment: "test-1" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: "company-2",
        environment: "test-1",
        sourceCompanyId: "company-1",
      });
      expect(mockCompanyService.cloneToEnvironment).toHaveBeenCalledWith("company-1", "test-1");
      expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
        "company-2",
        "user",
        "user-1",
        "owner",
        "active",
      );
    });

    it("rejects invalid environment names", async () => {
      const res = await request(createApp())
        .post("/companies/company-1/clone-to-environment")
        .send({ environment: "staging" });

      expect(res.status).toBe(400);
      expect(mockCompanyService.cloneToEnvironment).not.toHaveBeenCalled();
    });

    it("rejects 'production' as target environment", async () => {
      const res = await request(createApp())
        .post("/companies/company-1/clone-to-environment")
        .send({ environment: "production" });

      expect(res.status).toBe(400);
      expect(mockCompanyService.cloneToEnvironment).not.toHaveBeenCalled();
    });

    it("requires instance admin", async () => {
      const app = createApp({ source: "session", isInstanceAdmin: false });
      const res = await request(app)
        .post("/companies/company-1/clone-to-environment")
        .send({ environment: "test-1" });

      expect(res.status).toBe(403);
    });

    it("logs activity for the cloned company", async () => {
      const clonedCompany = {
        id: "company-2",
        name: "Test Corp [test-1]",
        environment: "test-1",
        sourceCompanyId: "company-1",
      };
      mockCompanyService.cloneToEnvironment.mockResolvedValue(clonedCompany);
      mockAccessService.ensureMembership.mockResolvedValue(undefined);
      mockLogActivity.mockResolvedValue(undefined);

      await request(createApp())
        .post("/companies/company-1/clone-to-environment")
        .send({ environment: "test-1" });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-2",
          action: "company.cloned_to_environment",
          details: { sourceCompanyId: "company-1", environment: "test-1" },
        }),
      );
    });
  });
});
