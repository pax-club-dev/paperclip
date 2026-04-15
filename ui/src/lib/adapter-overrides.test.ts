import { describe, expect, it } from "vitest";
import { buildAssigneeAdapterOverrides } from "./adapter-overrides";

const base = { adapterType: "", modelOverride: "", thinkingEffortOverride: "", chrome: false };

describe("buildAssigneeAdapterOverrides", () => {
  it("returns null for null adapterType", () => {
    expect(buildAssigneeAdapterOverrides({ ...base, adapterType: null })).toBeNull();
  });

  it("returns null for undefined adapterType", () => {
    expect(buildAssigneeAdapterOverrides({ ...base, adapterType: undefined })).toBeNull();
  });

  it("returns null for unsupported adapter type", () => {
    expect(buildAssigneeAdapterOverrides({ ...base, adapterType: "unknown_adapter" })).toBeNull();
  });

  it("returns null when no overrides are set for a supported adapter", () => {
    expect(buildAssigneeAdapterOverrides({ ...base, adapterType: "claude_local" })).toBeNull();
  });

  it("sets model override for any supported adapter", () => {
    for (const adapter of ["claude_local", "codex_local", "opencode_local"]) {
      const result = buildAssigneeAdapterOverrides({ ...base, adapterType: adapter, modelOverride: "gpt-4" });
      expect(result).toEqual({ adapterConfig: { model: "gpt-4" } });
    }
  });

  describe("thinking effort mapping", () => {
    it("maps codex_local thinking effort to modelReasoningEffort", () => {
      const result = buildAssigneeAdapterOverrides({
        ...base,
        adapterType: "codex_local",
        thinkingEffortOverride: "high",
      });
      expect(result).toEqual({ adapterConfig: { modelReasoningEffort: "high" } });
    });

    it("maps opencode_local thinking effort to variant", () => {
      const result = buildAssigneeAdapterOverrides({
        ...base,
        adapterType: "opencode_local",
        thinkingEffortOverride: "medium",
      });
      expect(result).toEqual({ adapterConfig: { variant: "medium" } });
    });

    it("maps claude_local thinking effort to effort", () => {
      const result = buildAssigneeAdapterOverrides({
        ...base,
        adapterType: "claude_local",
        thinkingEffortOverride: "low",
      });
      expect(result).toEqual({ adapterConfig: { effort: "low" } });
    });

    it("each adapter type maps to a unique config key", () => {
      const codex = buildAssigneeAdapterOverrides({ ...base, adapterType: "codex_local", thinkingEffortOverride: "x" });
      const opencode = buildAssigneeAdapterOverrides({ ...base, adapterType: "opencode_local", thinkingEffortOverride: "x" });
      const claude = buildAssigneeAdapterOverrides({ ...base, adapterType: "claude_local", thinkingEffortOverride: "x" });

      const codexKeys = Object.keys((codex as any).adapterConfig);
      const opencodeKeys = Object.keys((opencode as any).adapterConfig);
      const claudeKeys = Object.keys((claude as any).adapterConfig);

      expect(codexKeys).toContain("modelReasoningEffort");
      expect(opencodeKeys).toContain("variant");
      expect(claudeKeys).toContain("effort");

      expect(codexKeys).not.toContain("variant");
      expect(codexKeys).not.toContain("effort");
      expect(opencodeKeys).not.toContain("modelReasoningEffort");
      expect(opencodeKeys).not.toContain("effort");
      expect(claudeKeys).not.toContain("modelReasoningEffort");
      expect(claudeKeys).not.toContain("variant");
    });
  });

  describe("chrome flag", () => {
    it("sets chrome for claude_local when enabled", () => {
      const result = buildAssigneeAdapterOverrides({
        ...base,
        adapterType: "claude_local",
        chrome: true,
      });
      expect(result).toEqual({ adapterConfig: { chrome: true } });
    });

    it("does not set chrome for non-claude adapters", () => {
      for (const adapter of ["codex_local", "opencode_local"]) {
        const result = buildAssigneeAdapterOverrides({ ...base, adapterType: adapter, chrome: true });
        expect(result).toBeNull();
      }
    });

    it("ignores chrome=false", () => {
      const result = buildAssigneeAdapterOverrides({
        ...base,
        adapterType: "claude_local",
        chrome: false,
      });
      expect(result).toBeNull();
    });
  });

  it("combines model override, thinking effort, and chrome", () => {
    const result = buildAssigneeAdapterOverrides({
      adapterType: "claude_local",
      modelOverride: "opus",
      thinkingEffortOverride: "high",
      chrome: true,
    });
    expect(result).toEqual({
      adapterConfig: { model: "opus", effort: "high", chrome: true },
    });
  });
});
