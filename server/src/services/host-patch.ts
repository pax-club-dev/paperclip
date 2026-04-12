/**
 * Host Patch Gateway — secure server-side service for applying agent-produced
 * patches to the host filesystem.
 *
 * Agents run inside bwrap sandboxes with read-only access to the host repo.
 * This service runs outside the sandbox and acts as a gatekeeper: it validates,
 * typechecks, and applies patches on behalf of agents.
 *
 * Flow:
 *   1. Agent produces a unified diff (from its worktree or workspace)
 *   2. Agent POSTs the diff to /api/host/apply-patch
 *   3. Server validates via `git apply --check`
 *   4. Server applies via `git apply`
 *   5. Server runs `tsc --noEmit` to catch type errors
 *   6. Server commits with agent attribution
 *   7. dev-watch auto-restarts on file changes
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyPatchOpts {
  /** Unified diff content */
  patch: string;
  /** Human-readable commit message (agent provides) */
  commitMessage: string;
  /** Agent name for attribution */
  agentName?: string;
  /** Agent ID for audit trail */
  agentId?: string;
  /** Issue identifier (e.g. PAX-238) for commit message */
  issueIdentifier?: string;
  /** Skip typecheck (use with caution — for non-TS changes like docs, config) */
  skipTypecheck?: boolean;
  /** Target directory to apply patch in (defaults to repo root) */
  targetDir?: string;
}

export interface ApplyPatchResult {
  ok: boolean;
  commitSha?: string;
  error?: string;
  phase?: "validation" | "apply" | "typecheck" | "commit";
  details?: string;
}

export interface GitPushOpts {
  /** Remote name (default: "origin") */
  remote?: string;
  /** Branch to push (default: current branch) */
  branch?: string;
  /** Force push (default: false) */
  force?: boolean;
}

export interface GitPushResult {
  ok: boolean;
  remote?: string;
  branch?: string;
  error?: string;
  details?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function hostPatchService(repoRoot?: string) {
  const root = repoRoot ?? findRepoRoot();

  /**
   * Apply a unified diff to the host repo, typecheck, and commit.
   */
  async function applyPatch(opts: ApplyPatchOpts): Promise<ApplyPatchResult> {
    const targetDir = opts.targetDir ?? root;

    if (!opts.patch || opts.patch.trim().length === 0) {
      return { ok: false, error: "Patch content is empty", phase: "validation" };
    }

    if (!opts.commitMessage || opts.commitMessage.trim().length === 0) {
      return { ok: false, error: "Commit message is required", phase: "validation" };
    }

    // Write patch to a temp file (git apply reads from file more reliably
    // than stdin for large patches)
    const tmpPatch = path.join(os.tmpdir(), `paperclip-patch-${Date.now()}.patch`);
    try {
      await writeFile(tmpPatch, opts.patch, "utf-8");

      // Phase 1: Validate — dry run
      logger.info(
        { targetDir, patchSize: opts.patch.length, agent: opts.agentName },
        "host-patch: validating patch (dry run)",
      );
      try {
        await execFile("git", ["apply", "--check", "--stat", tmpPatch], {
          cwd: targetDir,
          timeout: 30_000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as any).stderr ?? err.message : String(err);
        logger.warn({ err: msg, agent: opts.agentName }, "host-patch: patch validation failed");
        return {
          ok: false,
          error: "Patch does not apply cleanly",
          phase: "validation",
          details: truncate(msg, 2000),
        };
      }

      // Phase 2: Apply
      logger.info({ targetDir, agent: opts.agentName }, "host-patch: applying patch");
      try {
        await execFile("git", ["apply", tmpPatch], {
          cwd: targetDir,
          timeout: 30_000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as any).stderr ?? err.message : String(err);
        logger.error({ err: msg, agent: opts.agentName }, "host-patch: git apply failed");
        return {
          ok: false,
          error: "git apply failed",
          phase: "apply",
          details: truncate(msg, 2000),
        };
      }

      // Phase 3: Typecheck (optional)
      if (!opts.skipTypecheck) {
        logger.info({ targetDir, agent: opts.agentName }, "host-patch: running typecheck");
        try {
          await execFile("npx", ["tsc", "--noEmit"], {
            cwd: targetDir,
            timeout: 120_000,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? (err as any).stderr ?? (err as any).stdout ?? err.message : String(err);
          logger.error({ err: msg, agent: opts.agentName }, "host-patch: typecheck failed, reverting");

          // Revert the patch since it doesn't typecheck
          await execFile("git", ["apply", "--reverse", tmpPatch], {
            cwd: targetDir,
            timeout: 30_000,
          }).catch((revertErr) => {
            logger.error({ err: revertErr }, "host-patch: failed to revert bad patch");
          });

          return {
            ok: false,
            error: "Typecheck failed — patch reverted",
            phase: "typecheck",
            details: truncate(msg, 4000),
          };
        }
      }

      // Phase 4: Stage and commit
      logger.info({ targetDir, agent: opts.agentName }, "host-patch: committing");
      try {
        await execFile("git", ["add", "-A"], { cwd: targetDir, timeout: 15_000 });

        const attribution = opts.agentName
          ? `\n\nApplied-By: ${opts.agentName}${opts.agentId ? ` (${opts.agentId})` : ""}`
          : "";
        const issueRef = opts.issueIdentifier ? `${opts.issueIdentifier}: ` : "";
        const fullMessage = `${issueRef}${opts.commitMessage}${attribution}`;

        const { stdout } = await execFile(
          "git",
          ["commit", "-m", fullMessage, "--allow-empty-message"],
          { cwd: targetDir, timeout: 15_000 },
        );

        // Extract commit SHA
        const shaMatch = stdout.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
        const commitSha = shaMatch?.[1] ?? "unknown";

        logger.info(
          {
            commitSha,
            agent: opts.agentName,
            issueIdentifier: opts.issueIdentifier,
            patchSize: opts.patch.length,
          },
          "host-patch: patch applied and committed successfully",
        );

        return { ok: true, commitSha };
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as any).stderr ?? err.message : String(err);

        // "nothing to commit" is not an error — patch may have been a no-op
        if (msg.includes("nothing to commit")) {
          logger.info({ agent: opts.agentName }, "host-patch: patch was already applied (no changes)");
          return { ok: true, commitSha: "no-change" };
        }

        logger.error({ err: msg, agent: opts.agentName }, "host-patch: commit failed");
        return {
          ok: false,
          error: "Commit failed",
          phase: "commit",
          details: truncate(msg, 2000),
        };
      }
    } finally {
      // Clean up temp file
      await unlink(tmpPatch).catch(() => {});
    }
  }

  /**
   * Push the current branch to a remote.
   */
  async function gitPush(opts: GitPushOpts = {}): Promise<GitPushResult> {
    const remote = opts.remote ?? "origin";
    const force = opts.force ?? false;

    // Resolve current branch if not specified
    let branch = opts.branch;
    if (!branch) {
      try {
        const { stdout } = await execFile(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: root, timeout: 10_000 },
        );
        branch = stdout.trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: "Could not determine current branch", details: msg };
      }
    }

    logger.info(
      { remote, branch, force },
      "host-patch: pushing to remote",
    );

    try {
      const args = ["push", remote, branch];
      if (force) args.push("--force-with-lease");

      const { stdout, stderr } = await execFile("git", args, {
        cwd: root,
        timeout: 60_000,
      });

      logger.info(
        { remote, branch, output: (stderr || stdout).slice(0, 500) },
        "host-patch: push succeeded",
      );

      return { ok: true, remote, branch };
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as any).stderr ?? err.message : String(err);
      logger.error({ err: msg, remote, branch }, "host-patch: push failed");
      return {
        ok: false,
        remote,
        branch,
        error: "git push failed",
        details: truncate(msg, 2000),
      };
    }
  }

  /**
   * Get current git status (for diagnostics).
   */
  async function gitStatus(): Promise<{ branch: string; clean: boolean; summary: string }> {
    try {
      const { stdout: branchOut } = await execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: root, timeout: 10_000 },
      );
      const { stdout: statusOut } = await execFile(
        "git",
        ["status", "--short"],
        { cwd: root, timeout: 10_000 },
      );
      return {
        branch: branchOut.trim(),
        clean: statusOut.trim().length === 0,
        summary: statusOut.trim().slice(0, 1000),
      };
    } catch {
      return { branch: "unknown", clean: false, summary: "error reading git status" };
    }
  }

  return { applyPatch, gitPush, gitStatus };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  // Check if we're running from the repo
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, ".git"))) return cwd;

  // Fall back to home directory check
  const home = os.homedir();
  const paperclip = path.join(home, "paperclip");
  if (existsSync(path.join(paperclip, ".git"))) return paperclip;

  // Last resort: cwd
  return cwd;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
