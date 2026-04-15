export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);

export function buildAssigneeAdapterOverrides(input: {
  adapterType: string | null | undefined;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
}): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (adapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (adapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    }
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(adapterConfig).length > 0) {
    overrides.adapterConfig = adapterConfig;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}
