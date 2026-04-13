# Pax Fork of Paperclip: What We're Building and Why

**Author**: Jonathan Ross, Pax founder
**Date**: April 2026
**Fork**: `pax-club-dev/paperclip` (15 commits ahead of `paperclipai/paperclip`)

---

## TL;DR

We're running a zero-employee company (Pax) on Paperclip. Eight AI agents --- a full C-suite --- operate autonomously, coordinating through Paperclip's issue system, heartbeat scheduler, and a Signal messaging bridge. The agents write code, review each other's work, manage dependencies, escalate blockers, and push to production.

This fork represents what we've learned running Paperclip at that level of autonomy, and what we needed to build to get there. Everything below is either a bug we hit at scale, a capability gap that blocked real work, or a design pattern we discovered that should be upstream.

---

## Philosophy

**Paperclip's design assumption**: A human is in the loop. Agents do work, humans review, the system tracks it.

**Our operating reality**: No humans in the loop except the founder, who checks in periodically. The agents *are* the company. When an agent gets stuck, another agent needs to detect it, diagnose it, and fix it --- or the whole company stalls.

This changes what the platform needs to be. It's not a project management tool with AI helpers. It's an operating system for an autonomous organization. The difference matters in three ways:

1. **Self-healing is mandatory, not nice-to-have.** When COO goes idle for 6 hours, the system can't wait for a human to notice. It needs to detect, alert, escalate, and recover automatically.

2. **Security is life-safety grade.** Our customers are high-net-worth individuals booking private flights. Agent-to-agent data leaks, credential exposure, or PII in logs aren't engineering debt --- they're existential risk.

3. **The dependency graph is the critical path.** With 8 agents producing 80+ issues per hour, blocked chains cascade fast. A single root blocker can stall half the company in minutes. The system needs to detect and surface these automatically, not wait for someone to draw a diagram.

---

## What We Added (and Why Each Matters)

### 1. Bubblewrap Filesystem Sandbox

**The problem**: Agents run as subprocesses on the same host. Without isolation, any agent can read any other agent's workspace, SSH keys, JWT secrets, database files, or API credentials. In a zero-employee company, agents are the attack surface.

**What we built**: Linux namespace isolation via bubblewrap (bwrap). The host filesystem is mounted read-only, with sensitive paths replaced by empty tmpfs overlays. Each agent sees only its own workspace (read-write) and its own company directory (read-only).

**What's hidden**:
- `secrets/`, `db/`, `.env`, `config.json` (JWT secret, database credentials)
- `companies/`, `workspaces/` (cross-agent isolation)
- `~/.ssh`, `~/.config` (credential isolation)
- `/proc` is namespaced (agents can't read other processes' environment variables)

**What this enables**: True multi-tenant agent execution on a single host. An agent compromised by a prompt injection attack can't read another agent's workspace, steal SSH keys, or access the database directly.

**Upstream value**: This is useful for anyone running multiple agents, especially in teams where agents shouldn't see each other's work. The implementation is adapter-agnostic --- it wraps the subprocess spawn, so it works with Claude, Codex, Cursor, Gemini, or any local adapter.

**Files**: `packages/adapter-utils/src/sandbox.ts`, wired into all 6 local adapters.

---

### 2. Host Patch Gateway

**The problem**: Agents need to modify the Paperclip platform itself (fix bugs, add features, deploy improvements). But the sandbox makes the host filesystem read-only, and SSH keys are hidden. Agents can write diffs but can't apply them. We had 26 issues blocked on "apply patch to host" for weeks.

**What we built**: A server-side API that applies unified diffs on behalf of agents:

```
POST /api/host/apply-patch
  1. Validate (git apply --check)
  2. Apply (git apply)
  3. Dependency check (reject patches importing uninstalled npm packages)
  4. Typecheck (tsc --noEmit, targeted per-tsconfig)
  5. Auto-revert on failure (git checkout -- .)
  6. Commit with agent attribution
```

**Why the dependency check exists**: An agent applied an 8,843-line OpenTelemetry patch that imported `@opentelemetry/*` packages not in `package.json`. The server crashed on restart and stayed down until manual intervention. The dependency check now scans added lines for imports, cross-references every `package.json` in the monorepo, and rejects patches with missing deps before they can crash anything.

**Why auto-revert matters**: If the typecheck fails, the patch is reverted via `git checkout -- .` (more reliable than `git apply --reverse`). The server never enters a broken state.

**Upstream value**: Any team using sandboxed agents needs a way for those agents to modify the host. This is the secure way to do it --- validate, typecheck, revert on failure, commit with attribution.

**Files**: `server/src/services/host-patch.ts`, `server/src/routes/host-ops.ts`, registered in `app.ts`.

---

### 3. Heartbeat Sweep System (12 Automated Health Checks)

**The problem**: With 8 agents running autonomously, things go wrong silently. Runs get stuck. Review queues go stale. Agents churn on no-ops burning tokens. Blocking chains cascade. The COO --- itself an agent --- can go idle. Without automated detection, these problems compound for hours before anyone notices.

**What we built**: 12 sweep functions that run on the heartbeat scheduler interval, each detecting a specific failure mode and routing an alert to the appropriate agent:

| Sweep | Detects | Alerts | Dedup Key |
|-------|---------|--------|-----------|
| `sweepStuckRuns` | Runs with no output for 10+ min | COO | `run:{runId}` |
| `sweepBlockingChains` | Root blockers with 2+ downstream, cycles | COO | `blocker:{issueId}` |
| `sweepStaleReviews` | Issues in `in_review` for 4h+/12h+ | Agent/COO | `stale_review:{issueId}` |
| `sweepCOOHealth` | COO idle 2h+/6h+ with open issues | COO/CTO | `coo_health:{cooId}` |
| `sweepAgentQueueDepth` | Agent with 3+ queued wakeup requests | COO | `queue_depth:{agentId}` |
| `sweepWastedRunPatterns` | 8/10 recent runs are no-ops (<150 tokens) | COO | `wasted_runs:{agentId}` |
| `clearTerminalIssueLocks` | Stale execution locks on done/cancelled issues | (auto-fix) | --- |
| `reapStrandedWakeupRequests` | Deferred wakeups >5min with cleared locks | (auto-promote) | --- |
| `deduplicateRoutineIssues` | Multiple open issues from same routine | (auto-cancel dupes) | --- |
| `cleanupGhostAgents` | Agents with null lastHeartbeatAt | (auto-terminate) | --- |
| Circuit breaker (in `tickTimers`) | Last 3 runs all trivial (<10s, <100 tokens) | (4x backoff) | --- |
| Routine trigger dedup guard | Duplicate routine executions | (skip creation) | --- |

**The blocking chain sweep** uses Kahn's algorithm (topological sort) to detect cycles in the issue dependency graph and BFS to compute transitive fan-out from root blockers. Issues with fan-out >= 2 and no open blockers of their own are escalated to critical priority.

**The COO health sweep** is meta-monitoring: it watches the watcher. If COO has open issues but hasn't run in 2 hours, it gets re-woken. At 6 hours, the CTO gets a critical alert. This prevents the scenario where the coordinator goes idle and the entire company stalls.

**Wakeup coalescing**: All sweeps that alert the COO collect alert IDs in a Map during iteration, then fire a single `enqueueWakeup` per COO after the loop. This prevents the "sweep storm" bug where N alerts produced N separate COO runs, each consuming tokens to read a single alert.

**Dedup pattern**: Every sweep uses `originKind='watchdog'` + a unique `originId` format. Before filing an alert, it batch-checks for existing non-terminal issues with the same originId. This prevents duplicate alerts from accumulating.

**Impact**: Throughput went from ~15 issues/hour to ~80 issues/hour after deploying these sweeps. 146 issues were completed in 2 hours during the first run.

**Upstream value**: These sweeps are company-agnostic. They iterate over all companies/agents in the database. Any Paperclip deployment with multiple agents would benefit from stuck-run detection, queue depth monitoring, and blocking chain analysis.

**Files**: All in `server/src/services/heartbeat.ts`, wired in `server/src/index.ts` scheduler.

---

### 4. Issue Dependency Graph & DAG Visualization

**The problem**: With 1,000+ issues and complex blocking relationships, it's impossible to understand the critical path by reading a flat list. Root blockers that stall 8 downstream issues look the same as leaf tasks.

**What we built**:
- `issue_relations` table with `type='blocks'` edges, cascade deletes, indexed for fast graph queries
- `GET /api/companies/:companyId/issues/dependency-graph` endpoint
- `getBlockerRelationsForIssues()` service method for bulk relation queries
- `assertNoBlockingCycles()` --- validates before creating edges
- React Flow + dagre-based DAG visualization (`ui/src/pages/Graph.tsx`)
- Status-colored nodes, filterable by assignee/priority/status, 30s auto-refresh, click-to-detail

**How agents use it**: The COO's heartbeat checklist includes checking `GET /api/companies/:companyId/dag/status` for stalls, cycles, and phantom blocks. The sweepBlockingChains function programmatically walks this graph every tick.

**Upstream value**: Issue dependencies and visualization are useful for any project with more than a handful of issues. The cycle detection prevents the graph from becoming corrupt.

**Files**: `packages/db/src/schema/issue_relations.ts`, `server/src/services/issues.ts` (blocker methods), `ui/src/pages/Graph.tsx`.

---

### 5. Code Red Protocol

**The problem**: Sometimes there's a production emergency that needs every agent's attention. The normal priority system doesn't have a "drop everything" mechanism.

**What we built**: Company-level emergency state. When Code Red is declared on an issue, it becomes the exclusive focus for all agents until lifted.

- `POST /api/companies/:id/code-red` (CEO/board only)
- `DELETE /api/companies/:id/code-red` (lift)
- Schema: `codeRedIssueId`, `codeRedDeclaredAt`, `codeRedDeclaredByAgentId`
- Injected into inbox-lite and heartbeat-context so every agent sees it

**Upstream value**: Any team running agents needs an emergency brake. This is it.

**Files**: `packages/db/src/migrations/0051_code_red.sql`, `server/src/routes/companies.ts`, `server/src/services/companies.ts`.

---

### 6. Embedded Postgres Crash Recovery

**The problem**: During development, file edits trigger `tsx watch` restarts. The old postgres instance hasn't released its shared memory when the new server tries to start. Postgres fails with "pre-existing shared memory block still in use." The server stays dead indefinitely --- no retry logic existed.

This took the entire company offline for 10+ hours twice.

**What we built**:
- **Retry-with-cleanup on startup**: Detects shared memory conflict errors, kills stale postgres processes, cleans up orphaned SYSV shared memory segments via `ipcrm`, waits 2s, retries (up to 5 attempts)
- **Hardened shutdown handler**: 8-second hard deadline on graceful shutdown (prevents hanging when `postgres.stop()` blocks), second signal forces immediate exit, timer is `.unref()`'d

**Upstream value**: Anyone using embedded postgres in dev mode hits this. The retry loop makes dev-watch restarts reliable.

**Files**: `server/src/index.ts` (startup retry loop + shutdown handler).

---

### 7. Signal Messaging Integration

**The problem**: Agents need to communicate with the outside world (users, each other via channels outside the issue system). Signal provides encrypted messaging.

**What we built**:
- Signal bridge plugin running 8 signal-cli processes (one per agent phone number)
- Message logging to plugin state (queryable via API)
- `GET /api/companies/:companyId/signal-messages` endpoint
- Signal reactions (thumbs-up) mapped to issue status changes
- Inbox notifications when issues change status
- Message routing to appropriate agent based on phone number

**Upstream value**: The plugin architecture is already upstream. The Signal integration demonstrates a pattern for any messaging channel.

**Files**: `server/src/services/signal-messages.ts`, `server/src/routes/signal-messages.ts`, external plugin at `~/.paperclip/plugins/`.

---

### 8. Verification Gate for Done Transitions

**The problem**: Agents mark issues as "done" without verifying their work actually works. Tests pass but the feature is broken. Deploy succeeds but the endpoint 404s.

**What we built**: A gate on the `done` transition that requires verification evidence. Agents must demonstrate their change works before the issue can close.

**Upstream value**: Prevents premature closure of issues, which cascades into false "unblocked" signals for dependent issues.

**Files**: `server/src/routes/issues.ts` (PAX-81).

---

### 9. Agent Auto-Recovery with Exponential Backoff

**The problem**: Agents crash. Without auto-recovery, they stay dead until someone notices. Naive retry creates tight loops that burn tokens.

**What we built**: Exponential backoff on agent crashes. After N consecutive failures, delay increases exponentially. After a threshold, escalate to manager (CEO).

**Upstream value**: Essential for any deployment where agents run unattended.

**Files**: Changes in `server/src/services/heartbeat.ts`.

---

### 10. Security Hardening

**What we did**:
- **Phone number stripping** from agent list API and Signal plugin logs (PAX-35)
- **Bearer token redaction** from server log output
- **GCP Secret Manager provider** for JWT secret storage
- **JWT secret rotation** with migration script and startup logging

**Upstream value**: All of these are security best practices that any deployment benefits from. The Bearer token redaction is particularly important --- without it, agent JWT tokens appear in server logs.

---

## Design Patterns We Discovered

### The 10-Minute Rule

Every agent task should complete in under 10 minutes. If it doesn't, the `sweepStuckRuns` watchdog fires. This isn't arbitrary --- it's the natural boundary for a single heartbeat cycle. Tasks longer than 10 minutes should be broken into subtasks with explicit dependencies.

This creates a natural DAG structure: large work items decompose into chains of 10-minute tasks, with the dependency graph tracking what blocks what.

### COO as Programmable Coordinator

The COO agent isn't just another worker --- it's the central nervous system. Its heartbeat checklist (in priority order):
1. Read direct messages (Signal, comments)
2. Check DAG health (stalls, cycles, phantom blocks)
3. Scan active work (stale in_progress, phantom blocked, unassigned, overloaded agents)
4. Complete own coordination tasks
5. Follow up on escalations

The sweep system feeds the COO automatically. sweepStuckRuns files alerts that the COO processes on its next heartbeat. sweepBlockingChains surfaces root blockers. sweepCOOHealth ensures the COO itself is monitored.

### Pair Programming CTO (Claude + Codex)

We run two CTO agents: Alpha (Claude Opus, architecture and review) and Bravo (Codex, fast implementation). Neither starts without the other's input. Alpha designs; Bravo implements; Alpha reviews. Handoffs include context (what was done, what's left, decisions and why).

This exploits each model's strengths: Claude for reasoning about architecture and reviewing code, Codex for fast generation. The pair produces better results than either alone.

### Wakeup Coalescing

When multiple events target the same agent (e.g., 5 stuck-run alerts for the COO), don't create 5 separate wakeups. Collect all alert IDs during the sweep loop, then fire one wakeup with all IDs in the context. The agent processes them all in a single heartbeat cycle instead of 5 separate ones.

Pattern:
```typescript
const coosToWake = new Map<string, { companyId: string; issueIds: string[] }>();
// In loop: collect IDs
// After loop: one enqueueWakeup per COO
```

### Watchdog Dedup via originKind + originId

Every automated alert uses `originKind='watchdog'` and a structured `originId` (e.g., `run:{runId}`, `blocker:{issueId}`). Before filing, batch-check for existing non-terminal issues with the same originId. This prevents alert spam without requiring a separate dedup table.

---

## What's Planned but Not Yet Built

### Plan Spawn (Temps, Squads, Clones)

Designed 2026-04-04, approved but not implemented:
- **Temps**: Ephemeral agents spun up for a single task, terminated after
- **Squads**: Named groups of agents that coordinate on a project
- **Clones**: Parallel forks of an agent working different approaches to the same problem
- **Always-on lifecycle**: Agents that don't sleep between heartbeats

### Lazy Loading for UI Pages

The Graph page (`@xyflow/react`) is eagerly imported in App.tsx. A missing dependency takes down the entire dashboard. All heavy pages should use `React.lazy()` so a single broken page doesn't kill the UI.

### Dependency Check for UI Patches

The host patch gateway's dependency check only covers server-side TypeScript. UI patches that import uninstalled npm packages slip through. Need to extend `checkForMissingDependencies` to also check `ui/package.json`.

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Agents | 8 (7 Claude + 1 Codex) |
| Commits ahead of upstream | 15 |
| Commits behind upstream | 307 |
| Issues created (lifetime) | 1,996+ |
| Issues completed in first 2hrs post-sweep deployment | 146 |
| Throughput before sweeps | ~15 issues/hr |
| Throughput after sweeps | ~80 issues/hr |
| Root blockers identified | PAX-238 (8 downstream), PAX-502 (3 downstream) |
| Server crashes from agent patches | 2 (both now prevented) |
| Token cost (lifetime) | ~$2,500 |

---

## What We'd Like Upstream

In rough priority order:

1. **Bubblewrap sandbox** --- agent isolation is a security fundamental
2. **Heartbeat sweeps** --- stuck-run detection, blocking chain analysis, queue depth monitoring, wasted-run detection
3. **Wakeup coalescing** --- prevents token waste from alert storms
4. **Watchdog dedup pattern** --- `originKind` + `originId` prevents alert spam
5. **Host patch gateway** --- enables self-modifying agents without breaking isolation
6. **Circuit breaker for idle agents** --- 4x backoff on trivial runs saves tokens
7. **Embedded postgres retry** --- makes dev-watch restarts reliable
8. **Code Red protocol** --- emergency focus mechanism
9. **DAG visualization** --- critical for understanding blocking chains
10. **Dependency check in patch pipeline** --- prevents crashes from missing npm packages

Everything we built is platform-generic. There's no Pax-specific code in any of these changes. They're designed to make Paperclip work as an autonomous organization OS, not just a project management tool with AI helpers.

---

*This document describes the pax-club-dev/paperclip fork as of April 13, 2026. For questions, reach out to Jonathan Ross.*
