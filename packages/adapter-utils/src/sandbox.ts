// Filesystem sandbox for agent processes using bubblewrap (bwrap).
//
// Prevents agents from reading other agents' workspaces, the master encryption
// key, the embedded database, JWT secrets, SSH keys, and other sensitive paths.
//
// Security model:
//   1. Mount the entire host FS read-only as the base layer.
//   2. Replace sensitive instance directories and files with empty tmpfs mounts
//      so the originals are invisible (secrets, db, workspaces, .env,
//      config.json, companies, data, logs, telemetry, runtime-services).
//   3. Re-mount the agent's own workspace and company directory appropriately.
//   4. Hide user-level sensitive dirs (~/.ssh, ~/.config).
//   5. Fresh /proc (PID namespace) hides other processes' /proc/[pid]/environ.
//   6. Private /tmp per sandbox.

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  /** Enable/disable sandboxing. When false, command runs unsandboxed. */
  enabled: boolean;
  /** Paperclip instance root (e.g. ~/.paperclip/instances/default). */
  instanceRoot: string;
  /** The agent's own workspace directory (gets rw mount). */
  agentWorkspace: string;
  /** The working directory for this run (gets rw mount). May differ from agentWorkspace. */
  cwd: string;
  /** The user's home directory (e.g. /home/user). Used to hide ~/.ssh and ~/.config. */
  homeDir?: string;
  /** The agent's own company directory under ${instanceRoot}/companies/ (gets ro mount). */
  companyDir?: string;
  /** Additional paths to mount read-write inside the sandbox. */
  additionalRwPaths?: string[];
  /** Additional paths to mount read-only inside the sandbox. */
  additionalRoPaths?: string[];
  /**
   * Behavior when bwrap is not available.
   * - "refuse": throw an error and prevent execution.
   * - "warn": log a warning and run unsandboxed.
   * Default: "warn"
   */
  fallback?: "refuse" | "warn";
}

export interface SandboxedCommand {
  command: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// bwrap availability check (cached)
// ---------------------------------------------------------------------------

let bwrapAvailable: boolean | null = null;

export function checkBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    execFileSync("bwrap", ["--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/** Reset the cached availability check (for testing). */
export function resetBwrapCache(): void {
  bwrapAvailable = null;
}

// ---------------------------------------------------------------------------
// bwrap argument builder
// ---------------------------------------------------------------------------

/**
 * Build a bwrap-wrapped command that isolates the agent process.
 *
 * Returns the original command/args unchanged if sandboxing is disabled or
 * bwrap is unavailable (and fallback is "warn").
 *
 * @throws If sandbox is enabled, bwrap is missing, and fallback is "refuse".
 */
export function wrapWithSandbox(
  config: SandboxConfig,
  command: string,
  args: string[],
  opts?: {
    onWarn?: (message: string) => void;
  },
): SandboxedCommand {
  if (!config.enabled) {
    return { command, args };
  }

  const available = checkBwrapAvailable();
  if (!available) {
    const fallback = config.fallback ?? "warn";
    if (fallback === "refuse") {
      throw new Error(
        "Sandbox enabled but bwrap is not installed. " +
          "Install bubblewrap (apt install bubblewrap) or set sandbox to false.",
      );
    }
    opts?.onWarn?.(
      "Sandbox enabled but bwrap not found — running agent UNSANDBOXED. " +
        "Install bubblewrap for filesystem isolation.",
    );
    return { command, args };
  }

  const bwrapArgs = buildBwrapArgs(config, command, args);
  return { command: "bwrap", args: bwrapArgs };
}

function buildBwrapArgs(
  config: SandboxConfig,
  command: string,
  args: string[],
): string[] {
  const { instanceRoot, agentWorkspace, cwd } = config;
  const result: string[] = [];

  // 1. Base layer: entire host filesystem read-only
  result.push("--ro-bind", "/", "/");

  // 2. Fresh /proc — isolates PID namespace, hides other processes' environ
  result.push("--proc", "/proc");

  // 3. Minimal /dev
  result.push("--dev", "/dev");

  // 4. Private /tmp
  result.push("--tmpfs", "/tmp");

  // 5. Hide sensitive instance directories and files by overlaying with empty
  //    tmpfs. Order matters: these override the ro-bind of / above.
  //
  //    Critical: JWT secret, encryption keys, database
  result.push("--tmpfs", `${instanceRoot}/secrets`);
  result.push("--tmpfs", `${instanceRoot}/db`);
  result.push("--tmpfs", `${instanceRoot}/workspaces`);
  //    .env exposes PAPERCLIP_AGENT_JWT_SECRET — agent could forge JWTs
  result.push("--tmpfs", `${instanceRoot}/.env`);
  //    config.json exposes DB port, backup paths, internal architecture
  result.push("--tmpfs", `${instanceRoot}/config.json`);
  //
  //    High: cross-company isolation, database backups
  result.push("--tmpfs", `${instanceRoot}/companies`);
  result.push("--tmpfs", `${instanceRoot}/data`);
  //
  //    Medium: operational data
  result.push("--tmpfs", `${instanceRoot}/logs`);
  result.push("--tmpfs", `${instanceRoot}/telemetry`);
  result.push("--tmpfs", `${instanceRoot}/runtime-services`);

  // 6. Hide user-level sensitive directories
  if (config.homeDir) {
    //    ~/.ssh contains SSH private keys (id_ed25519 etc.)
    result.push("--tmpfs", `${config.homeDir}/.ssh`);
    //    ~/.config contains GitHub CLI auth tokens and other credentials
    result.push("--tmpfs", `${config.homeDir}/.config`);
  }

  // 7. Re-mount agent's own company directory read-only (over the tmpfs
  //    that hid all companies). Agents need their own company's instructions
  //    and config but must not see other companies' data.
  if (config.companyDir) {
    result.push("--ro-bind", config.companyDir, config.companyDir);
  }

  // 8. Re-mount agent's own workspace rw (over the tmpfs that hid all workspaces)
  result.push("--bind", agentWorkspace, agentWorkspace);

  // 9. Mount working directory rw (may be same as agentWorkspace, or a project dir)
  if (cwd !== agentWorkspace) {
    result.push("--bind", cwd, cwd);
  }

  // 10. Additional read-write paths (e.g. git worktrees, project checkouts)
  if (config.additionalRwPaths) {
    for (const p of config.additionalRwPaths) {
      if (p && p !== agentWorkspace && p !== cwd) {
        result.push("--bind", p, p);
      }
    }
  }

  // 11. Additional read-only paths (e.g. skill directories under /tmp)
  if (config.additionalRoPaths) {
    for (const p of config.additionalRoPaths) {
      if (p) {
        result.push("--ro-bind", p, p);
      }
    }
  }

  // 12. Namespace and lifecycle options
  result.push("--unshare-pid");   // PID namespace: agent can't see/signal other processes
  result.push("--die-with-parent"); // Kill sandbox if parent (server) dies

  // 13. Separator and the actual command
  result.push("--", command, ...args);

  return result;
}
