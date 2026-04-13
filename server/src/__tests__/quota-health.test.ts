import { describe, expect, it } from "vitest";
import { classifyQuotaResult, isLikelyCreditError } from "../services/quota-health.js";

describe("quota-health", () => {
  it("detects known credit and auth error phrases", () => {
    expect(isLikelyCreditError("Credit balance is too low. Please top up.")).toBe(true);
    expect(isLikelyCreditError("token expired while contacting provider")).toBe(true);
    expect(isLikelyCreditError("Billing details required before continuing")).toBe(true);
  });

  it("ignores unrelated execution failures", () => {
    expect(isLikelyCreditError("workspace setup failed: git clone timeout")).toBe(false);
    expect(isLikelyCreditError("Tool hook blocked (bash): command not allowed")).toBe(false);
  });

  it("classifies warning and critical utilization thresholds", () => {
    expect(
      classifyQuotaResult({
        provider: "anthropic",
        ok: true,
        windows: [{ label: "7d", usedPercent: 81, resetsAt: null, valueLabel: null }],
      }).level,
    ).toBe("warning");

    expect(
      classifyQuotaResult({
        provider: "anthropic",
        ok: true,
        windows: [{ label: "7d", usedPercent: 96, resetsAt: null, valueLabel: null }],
      }).level,
    ).toBe("critical");
  });
});
