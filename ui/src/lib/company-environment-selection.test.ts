import { describe, expect, it } from "vitest";

type CompanyLike = { id: string; environment: string; status: string };

function enforceEnvironmentSelection(
  selectedCompanyId: string | null,
  companies: CompanyLike[],
  activeEnvironment: string,
): string | null {
  if (!selectedCompanyId || companies.length === 0) return selectedCompanyId;
  const selected = companies.find((c) => c.id === selectedCompanyId);
  if (!selected || selected.environment === activeEnvironment) return selectedCompanyId;
  const envCompanies = companies.filter(
    (c) => c.environment === activeEnvironment && c.status !== "archived",
  );
  return envCompanies[0]?.id ?? selectedCompanyId;
}

function resolveEnvironmentSafeCompanyId(
  dialogCompanyId: string | null,
  selectedCompanyId: string | null,
  companies: CompanyLike[],
  activeEnvironment: string,
): string | null {
  if (dialogCompanyId) return dialogCompanyId;
  if (selectedCompanyId) {
    const selected = companies.find((c) => c.id === selectedCompanyId);
    if (selected && selected.environment === activeEnvironment) return selectedCompanyId;
  }
  const envCompanies = companies.filter(
    (c) => c.status !== "archived" && c.environment === activeEnvironment,
  );
  return envCompanies[0]?.id ?? null;
}

const companies: CompanyLike[] = [
  { id: "prod-1", environment: "production", status: "active" },
  { id: "prod-2", environment: "production", status: "active" },
  { id: "prod-archived", environment: "production", status: "archived" },
  { id: "test1-1", environment: "test-1", status: "active" },
  { id: "test1-2", environment: "test-1", status: "active" },
  { id: "test2-1", environment: "test-2", status: "active" },
];

describe("enforceEnvironmentSelection (CompanyContext guard)", () => {
  it("keeps selection when company matches active environment", () => {
    expect(enforceEnvironmentSelection("prod-1", companies, "production")).toBe("prod-1");
  });

  it("keeps selection when company matches test environment", () => {
    expect(enforceEnvironmentSelection("test1-1", companies, "test-1")).toBe("test1-1");
  });

  it("switches to first env company when selected company is in wrong environment", () => {
    expect(enforceEnvironmentSelection("prod-1", companies, "test-1")).toBe("test1-1");
  });

  it("switches from test to production when environment changes", () => {
    expect(enforceEnvironmentSelection("test1-1", companies, "production")).toBe("prod-1");
  });

  it("switches between test environments", () => {
    expect(enforceEnvironmentSelection("test1-1", companies, "test-2")).toBe("test2-1");
  });

  it("keeps selection when company ID not found in list", () => {
    expect(enforceEnvironmentSelection("unknown-id", companies, "production")).toBe("unknown-id");
  });

  it("returns null when selectedCompanyId is null", () => {
    expect(enforceEnvironmentSelection(null, companies, "production")).toBeNull();
  });

  it("returns selection unchanged when companies list is empty", () => {
    expect(enforceEnvironmentSelection("prod-1", [], "production")).toBe("prod-1");
  });

  it("skips archived companies when selecting replacement", () => {
    const withOnlyArchived: CompanyLike[] = [
      { id: "prod-1", environment: "production", status: "active" },
      { id: "test-archived", environment: "test-1", status: "archived" },
    ];
    expect(enforceEnvironmentSelection("prod-1", withOnlyArchived, "test-1")).toBe("prod-1");
  });

  it("does not leak production data into test environment", () => {
    const result = enforceEnvironmentSelection("prod-1", companies, "test-1");
    const resultCompany = companies.find((c) => c.id === result);
    expect(resultCompany?.environment).toBe("test-1");
  });

  it("does not leak test data into production environment", () => {
    const result = enforceEnvironmentSelection("test1-1", companies, "production");
    const resultCompany = companies.find((c) => c.id === result);
    expect(resultCompany?.environment).toBe("production");
  });
});

describe("resolveEnvironmentSafeCompanyId (NewIssueDialog)", () => {
  it("uses dialogCompanyId when set", () => {
    expect(resolveEnvironmentSafeCompanyId("test1-1", "prod-1", companies, "production")).toBe("test1-1");
  });

  it("uses selectedCompanyId when it matches active environment", () => {
    expect(resolveEnvironmentSafeCompanyId(null, "prod-1", companies, "production")).toBe("prod-1");
  });

  it("rejects selectedCompanyId from wrong environment and picks correct one", () => {
    expect(resolveEnvironmentSafeCompanyId(null, "prod-1", companies, "test-1")).toBe("test1-1");
  });

  it("falls back to first env company when selectedCompanyId is null", () => {
    expect(resolveEnvironmentSafeCompanyId(null, null, companies, "test-1")).toBe("test1-1");
  });

  it("returns null when no companies exist in environment", () => {
    expect(resolveEnvironmentSafeCompanyId(null, null, companies, "test-99")).toBeNull();
  });

  it("does not use a production company when in test environment", () => {
    const result = resolveEnvironmentSafeCompanyId(null, "prod-1", companies, "test-2");
    expect(result).toBe("test2-1");
    const resultCompany = companies.find((c) => c.id === result);
    expect(resultCompany?.environment).not.toBe("production");
  });

  it("does not use a test company when in production environment", () => {
    const result = resolveEnvironmentSafeCompanyId(null, "test1-1", companies, "production");
    expect(result).toBe("prod-1");
    const resultCompany = companies.find((c) => c.id === result);
    expect(resultCompany?.environment).toBe("production");
  });

  it("skips archived companies when falling back", () => {
    const result = resolveEnvironmentSafeCompanyId(null, "test1-1", [
      ...companies,
    ], "production");
    const resultCompany = companies.find((c) => c.id === result);
    expect(resultCompany?.status).not.toBe("archived");
  });
});

describe("regression: environment switch data isolation", () => {
  it("creating issue in test env then switching to prod never returns test company id", () => {
    const testCompanyId = resolveEnvironmentSafeCompanyId(null, "test1-1", companies, "test-1");
    expect(testCompanyId).toBe("test1-1");

    const afterSwitch = enforceEnvironmentSelection(testCompanyId, companies, "production");
    const afterSwitchCompany = companies.find((c) => c.id === afterSwitch);
    expect(afterSwitchCompany?.environment).toBe("production");
  });

  it("switching prod→test→prod never exposes test company as selected", () => {
    let selected: string | null = "prod-1";

    selected = enforceEnvironmentSelection(selected, companies, "test-1");
    expect(companies.find((c) => c.id === selected)?.environment).toBe("test-1");

    selected = enforceEnvironmentSelection(selected, companies, "production");
    expect(companies.find((c) => c.id === selected)?.environment).toBe("production");
  });

  it("dialog always resolves to active environment company", () => {
    for (const env of ["production", "test-1", "test-2"]) {
      const result = resolveEnvironmentSafeCompanyId(null, "prod-1", companies, env);
      if (result) {
        const company = companies.find((c) => c.id === result);
        expect(company?.environment).toBe(env);
      }
    }
  });
});
