// Per-process memory cap for adapter children using systemd-run user scopes.
//
// Wraps a command with `systemd-run --user --scope -p MemoryMax=<N>
// -p MemorySwapMax=0`. The kernel OOM-kills inside the scope if the child tree
// exceeds the cap, leaving the rest of the host untouched.
//
// Only applies on Linux with systemd-run available. Falls back to the original
// command unchanged otherwise. Disabled entirely when PAPERCLIP_DISABLE_MEMORY_CAPS=1.
//
// NOTE: systemd-run --scope drops fds beyond 0/1/2, so it is NOT safe for
// Node fork() IPC. Use it only for stdio-only children (adapter CLIs, spawn).
//
// Scope naming: callers pass a deterministic `unitName` (e.g.
// "paperclip-run-<runId>.scope") so the cgroup path is known pre-spawn. This
// lets resource-monitor read /sys/fs/cgroup/.../<unitName>/memory.current
// without racing the PID→cgroup lookup.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface MemoryCgroupCommand {
  command: string;
  args: string[];
}

/**
 * Per-adapter default memory caps. Bumped from the prior 1G after five OOM
 * kills in a day inside 1G scopes — three at <400 MB RSS where siblings pushed
 * the scope over the cap. Claude gets more headroom because its Bun JIT +
 * tool-call scratch can legitimately spike above 2 GB.
 */
export const DEFAULT_CAPS_BY_ADAPTER: Record<string, string> = {
  claude: "4G",
  claude_local: "4G",
  codex: "3G",
  codex_local: "3G",
  gemini: "3G",
  gemini_local: "3G",
  pi: "3G",
  pi_local: "3G",
  cursor: "3G",
  cursor_local: "3G",
  opencode: "3G",
  opencode_local: "3G",
  hermes_local: "3G",
};
export const DEFAULT_CAP_FALLBACK = "2G";

export function defaultMemoryMaxFor(adapterType: string | undefined): string {
  const envOverride = process.env.PAPERCLIP_ADAPTER_MEMORY_MAX;
  if (envOverride) return envOverride;
  if (adapterType && adapterType in DEFAULT_CAPS_BY_ADAPTER) {
    return DEFAULT_CAPS_BY_ADAPTER[adapterType];
  }
  return DEFAULT_CAP_FALLBACK;
}

let systemdRunAvailable: boolean | null = null;

export function checkSystemdRunAvailable(): boolean {
  if (systemdRunAvailable !== null) return systemdRunAvailable;
  if (process.platform !== "linux") {
    systemdRunAvailable = false;
    return false;
  }
  if (!existsSync("/usr/bin/systemd-run") && !existsSync("/bin/systemd-run")) {
    systemdRunAvailable = false;
    return false;
  }
  try {
    const probe = spawnSync(
      "systemd-run",
      ["--user", "--scope", "--quiet", "--", "true"],
      { stdio: "ignore", timeout: 5000 },
    );
    systemdRunAvailable = probe.status === 0;
  } catch {
    systemdRunAvailable = false;
  }
  return systemdRunAvailable;
}

export function resetSystemdRunCache(): void {
  systemdRunAvailable = null;
}

/**
 * Sanitize a runId (or any identifier) into a systemd-safe unit suffix.
 * systemd allows [a-zA-Z0-9:_.\\-] in unit names — strip anything else.
 */
export function sanitizeUnitSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9:_.\-]/g, "_").slice(0, 200);
}

export function scopeUnitName(runId: string): string {
  return `paperclip-run-${sanitizeUnitSuffix(runId)}.scope`;
}

export function wrapWithMemoryCgroup(
  command: string,
  args: string[],
  opts?: {
    memoryMax?: string;
    memorySwapMax?: string;
    /** Systemd unit name — if unset, systemd-run picks `run-<uuid>.scope`. */
    unitName?: string;
    /** Adapter type, for picking a default cap when memoryMax is unset. */
    adapterType?: string;
    onWarn?: (message: string) => void;
  },
): MemoryCgroupCommand {
  if (process.env.PAPERCLIP_DISABLE_MEMORY_CAPS === "1") {
    return { command, args };
  }
  if (!checkSystemdRunAvailable()) {
    opts?.onWarn?.(
      "memory-cgroup: systemd-run unavailable — adapter runs without per-process memory cap",
    );
    return { command, args };
  }

  const memoryMax = opts?.memoryMax ?? defaultMemoryMaxFor(opts?.adapterType);
  const memorySwapMax = opts?.memorySwapMax ?? "0";

  const wrapped: string[] = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
  ];
  if (opts?.unitName) {
    wrapped.push(`--unit=${opts.unitName}`);
  }
  wrapped.push(
    `--property=MemoryMax=${memoryMax}`,
    `--property=MemorySwapMax=${memorySwapMax}`,
    "--",
    command,
    ...args,
  );

  return { command: "systemd-run", args: wrapped };
}
