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
      //
      // Uses --project to target server tsconfig specifically (faster than
      // whole-monorepo check). On failure, reverts via `git checkout` on
      // the affected files rather than reverse-apply (more reliable).
      if (!opts.skipTypecheck) {
        logger.info({ targetDir, agent: opts.agentName }, "host-patch: running typecheck");

        // Determine which tsconfig(s) to check based on affected files
        const tsconfigPaths = await findAffectedTsconfigs(targetDir, opts.patch);

        let typecheckFailed = false;
        let typecheckError = "";

        for (const tsconfigPath of tsconfigPaths) {
          try {
            await execFile(
              "npx",
              ["tsc", "--noEmit", "--project", tsconfigPath],
              { cwd: targetDir, timeout: 180_000 },
            );
          } catch (err: unknown) {
            typecheckFailed = true;
            const msg = err instanceof Error ? (err as any).stderr ?? (err as any).stdout ?? err.message : String(err);
            typecheckError += `${tsconfigPath}:\n${msg}\n`;
          }
        }

        if (typecheckFailed) {
          logger.error(
            { err: typecheckError.slice(0, 500), agent: opts.agentName },
            "host-patch: typecheck failed, reverting",
          );

          // Revert via git checkout (more reliable than reverse-apply)
          await execFile("git", ["checkout", "--", "."], {
            cwd: targetDir,
            timeout: 30_000,
          }).catch((revertErr) => {
            logger.error({ err: revertErr }, "host-patch: failed to revert bad patch via checkout");
          });

          return {
            ok: false,
            error: "Typecheck failed — patch reverted",
            phase: "typecheck",
            details: truncate(typecheckError, 4000),
          };
        }
      }

      // Phase 4: Stage and commit
      logger.info({ targetDir, agent: opts.agentName }, "host-patch: committing");
      try {
        // Stage only the files touched by this patch (avoids bundling unrelated dirty-tree changes)
        const affectedPaths = extractPatchedPaths(opts.patch);
        if (affectedPaths.length > 0) {
          await execFile("git", ["add", "--", ...affectedPaths], { cwd: targetDir, timeout: 15_000 });
        } else {
          // Fallback: if no paths parsed from the diff, stage everything
          await execFile("git", ["add", "-A"], { cwd: targetDir, timeout: 15_000 });
        }

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

/**
 * Parse a unified diff to find affected file paths, then map each to the
 * nearest tsconfig.json. Returns a de-duplicated list of tsconfigs to check.
 */
async function findAffectedTsconfigs(repoRoot: string, patch: string): Promise<string[]> {
  // Extract file paths from diff headers (--- a/foo and +++ b/foo)
  const filePathPattern = /^[+-]{3} [ab]\/(.+)$/gm;
  const files = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = filePathPattern.exec(patch)) !== null) {
    if (match[1] !== "/dev/null") files.add(match[1]);
  }

  // For each file, walk up to find the nearest tsconfig.json
  const tsconfigs = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    let dir = path.dirname(path.join(repoRoot, file));
    while (dir.startsWith(repoRoot)) {
      const candidate = path.join(dir, "tsconfig.json");
      if (existsSync(candidate)) {
        tsconfigs.add(candidate);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Fallback: if we couldn't find any, check server tsconfig
  if (tsconfigs.size === 0) {
    const serverTsc = path.join(repoRoot, "server", "tsconfig.json");
    if (existsSync(serverTsc)) tsconfigs.add(serverTsc);
  }

  return [...tsconfigs];
}

/**
 * Extract file paths touched by a unified diff.
 * Parses `--- a/path` and `+++ b/path` headers, deduplicates, returns relative paths.
 */
function extractPatchedPaths(patch: string): string[] {
  const headerRe = /^[+-]{3} [ab]\/(.+)$/gm;
  const paths = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(patch)) !== null) {
    if (m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Scan added lines in a unified diff for `import … from '…'` and `require('…')`
 * statements that reference npm packages not listed in any package.json in the
 * repo. Returns the list of missing package names (e.g. `["@opentelemetry/api"]`).
 */
async function checkForMissingDependencies(
  repoRoot: string,
  patch: string,
): Promise<string[]> {
  // 1. Collect every npm package name imported in added lines
  const imported = new Set<string>();

  // Only look at added lines (start with "+", but not "+++ b/…" diff headers)
  const addedLines = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  // ES import: import … from "pkg"  /  import "pkg"
  const esImportRe = /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  // CJS require: require("pkg")
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const line of addedLines) {
    const raw = line.slice(1); // strip leading "+"
    for (const re of [esImportRe, requireRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const specifier = m[1];
        // Skip relative / absolute paths
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
        // Extract bare package name (handle scoped packages)
        const pkgName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        imported.add(pkgName);
      }
    }
  }

  if (imported.size === 0) return [];

  // 2. Skip Node built-in modules
  const nodeBuiltins = new Set([
    "assert", "async_hooks", "buffer", "child_process", "cluster",
    "console", "constants", "crypto", "dgram", "diagnostics_channel",
    "dns", "domain", "events", "fs", "http", "http2", "https",
    "inspector", "module", "net", "os", "path", "perf_hooks",
    "process", "punycode", "querystring", "readline", "repl",
    "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
    "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  ]);
  for (const pkg of imported) {
    if (pkg.startsWith("node:") || nodeBuiltins.has(pkg)) {
      imported.delete(pkg);
    }
  }

  if (imported.size === 0) return [];

  // 3. Collect all declared dependencies from workspace package.json files
  const declared = new Set<string>();

  const pkgJsonPaths = await findWorkspacePackageJsons(repoRoot);
  pkgJsonPaths.push(path.join(repoRoot, "package.json"));

  for (const pjPath of pkgJsonPaths) {
    try {
      const raw = await readFile(pjPath, "utf-8");
      const pkg = JSON.parse(raw);
      for (const depField of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        if (pkg[depField] && typeof pkg[depField] === "object") {
          for (const name of Object.keys(pkg[depField])) {
            declared.add(name);
          }
        }
      }
    } catch {
      // Skip unreadable package.json
    }
  }

  // 4. Return imported packages not found in any package.json
  const missing: string[] = [];
  for (const pkg of imported) {
    if (!declared.has(pkg)) {
      missing.push(pkg);
    }
  }

  return missing.sort();
}

/**
 * Find package.json files in the workspace (excluding node_modules).
 * Walks known monorepo directories rather than a full glob.
 */
async function findWorkspacePackageJsons(repoRoot: string): Promise<string[]> {
  const results: string[] = [];
  const topDirs = ["server", "cli", "ui", "packages"];

  for (const topDir of topDirs) {
    const dir = path.join(repoRoot, topDir);
    if (!existsSync(dir)) continue;

    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) results.push(candidate);

    // One level deeper (packages/shared, packages/db, etc.)
    try {
      const { stdout } = await execFile("ls", [dir], { timeout: 5_000 });
      for (const sub of stdout.trim().split("\n").filter(Boolean)) {
        const subPkg = path.join(dir, sub, "package.json");
        if (existsSync(subPkg)) results.push(subPkg);

        // Two levels for packages/adapters/*/package.json, packages/plugins/*/package.json
        const subDir = path.join(dir, sub);
        try {
          const { stdout: inner } = await execFile("ls", [subDir], { timeout: 5_000 });
          for (const deep of inner.trim().split("\n").filter(Boolean)) {
            const deepPkg = path.join(subDir, deep, "package.json");
            if (existsSync(deepPkg)) results.push(deepPkg);
          }
        } catch {
          // Not a directory or no children
        }
      }
    } catch {
      // Not a directory
    }
  }

  return results;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
