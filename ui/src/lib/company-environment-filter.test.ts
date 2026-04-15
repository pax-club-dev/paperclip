import { describe, expect, it } from "vitest";

type CompanyLike = { id: string; environment: string; status: string; name: string };

function filterCompaniesForDialog(companies: CompanyLike[], activeEnvironment: string) {
  return companies.filter((c) => c.status !== "archived" && c.environment === activeEnvironment);
}

const companies: CompanyLike[] = [
  { id: "prod-1", environment: "production", status: "active", name: "Acme Corp" },
  { id: "prod-2", environment: "production", status: "active", name: "Beta Inc" },
  { id: "prod-3", environment: "production", status: "archived", name: "Old Corp" },
  { id: "test1-1", environment: "test-1", status: "active", name: "Acme Corp (T1)" },
  { id: "test1-2", environment: "test-1", status: "archived", name: "Old Corp (T1)" },
  { id: "test2-1", environment: "test-2", status: "active", name: "Acme Corp (T2)" },
  { id: "test2-2", environment: "test-2", status: "active", name: "Beta Inc (T2)" },
];

describe("company environment filtering for dialog picker", () => {
  it("shows only production companies in production mode", () => {
    const result = filterCompaniesForDialog(companies, "production");
    expect(result.map((c) => c.id)).toEqual(["prod-1", "prod-2"]);
  });

  it("excludes archived companies in production mode", () => {
    const result = filterCompaniesForDialog(companies, "production");
    expect(result.find((c) => c.id === "prod-3")).toBeUndefined();
  });

  it("shows only test-1 companies in test-1 mode", () => {
    const result = filterCompaniesForDialog(companies, "test-1");
    expect(result.map((c) => c.id)).toEqual(["test1-1"]);
  });

  it("excludes archived companies in test environments", () => {
    const result = filterCompaniesForDialog(companies, "test-1");
    expect(result.find((c) => c.id === "test1-2")).toBeUndefined();
  });

  it("shows only test-2 companies in test-2 mode", () => {
    const result = filterCompaniesForDialog(companies, "test-2");
    expect(result.map((c) => c.id)).toEqual(["test2-1", "test2-2"]);
  });

  it("returns empty for unknown environment", () => {
    expect(filterCompaniesForDialog(companies, "test-99")).toEqual([]);
  });

  it("does not leak production companies into test environments", () => {
    const result = filterCompaniesForDialog(companies, "test-1");
    const prodIds = result.filter((c) => c.environment === "production");
    expect(prodIds).toHaveLength(0);
  });

  it("does not leak test companies into production", () => {
    const result = filterCompaniesForDialog(companies, "production");
    const testIds = result.filter((c) => c.environment !== "production");
    expect(testIds).toHaveLength(0);
  });

  describe("regression: old filter only checked status", () => {
    it("old filter would show all non-archived companies regardless of env", () => {
      const oldFilter = companies.filter((c) => c.status !== "archived");
      expect(oldFilter).toHaveLength(5);
    });

    it("new filter correctly scopes to active environment", () => {
      const newFilter = filterCompaniesForDialog(companies, "production");
      expect(newFilter).toHaveLength(2);
    });
  });
});
