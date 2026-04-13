# DAG-Driven Event Dispatch Architecture

**Status**: Design approved, implementation in progress
**Priority**: Critical
**Author**: Jonathan Ross / Claude
**Date**: 2026-04-12

## Problem Statement

The Paperclip heartbeat system uses timer-based polling as its primary
scheduling mechanism. Engineering agents wake every 300s, leadership every
1800s. When issue A completes and unblocks issues B and C, the assigned
agents must wait for their next timer tick before discovering work — a
latency of up to 30 minutes for leadership agents.

The system already has event-driven wakeups for specific cases (blocker
resolution, assignment, @-mentions), but they operate alongside the timer
as a secondary mechanism. Two critical gaps remain:

1. **No DAG-aware prioritization** — When an agent becomes idle with
   multiple ready issues, `autoWakeIdleAgentIfAssignableWork()` picks
   arbitrarily (`LIMIT 1`, no `ORDER BY`). `startNextQueuedRunForAgent()`
   uses FIFO (`ORDER BY createdAt`). Neither considers issue priority,
   downstream fan-out, or critical path position.

2. **Timer is still the primary work loop** — Even with event-driven
   wakeups, agents rely on periodic timers for general awareness. This
   wastes tokens on no-op runs (the circuit breaker mitigates but doesn't
   eliminate) and adds latency between DAG state changes and agent action.

## Design Goals

1. **Events as primary dispatch**: Every state change that could unblock
   work triggers immediate evaluation. No agent waits for a timer when
   work is available.

2. **DAG-aware prioritization**: When multiple issues compete for an
   agent's attention, select by: priority field -> transitive downstream
   fan-out -> critical path depth -> wait time.

3. **Timers as safety net**: Keep timers at longer intervals (10-15 min
   engineering, 30-60 min leadership) as a catch-all for missed events.

4. **Zero invariant violations**: Preserve execution locks, wakeup
   coalescing, deferred execution, budget checks, and transaction
   boundaries.

5. **Incremental and reversible**: Each phase deploys independently.

## Current Architecture

### Event-Driven Paths (already exist)

| Trigger | Handler | Effect |
|---------|---------|--------|
| Issue assigned | `routes/issues.ts` L1487 | `enqueueWakeup(source: "assignment")` |
| Issue moved from backlog | `routes/issues.ts` L1507 | `enqueueWakeup(source: "automation")` |
| Issue -> done | `routes/issues.ts` L1556 | `listWakeableBlockedDependents()` -> wakeup per dependent |
| Issue -> terminal + parent | `routes/issues.ts` L1583 | `getWakeableParentAfterChildCompletion()` -> wakeup parent agent |
| @-mention in comment | `routes/issues.ts` L1535 | `enqueueWakeup` per mentioned agent |
| Run completes, agent idle | `heartbeat.ts:finalizeAgentStatus` L2706 | `autoWakeIdleAgentIfAssignableWork()` |
| Run completes, issue unlock | `heartbeat.ts:executeRun` finally L5702 | `startNextQueuedRunForAgent()` |
| Issue execution released | `heartbeat.ts:releaseIssueExecutionAndPromote` L5706 | Promote oldest deferred wakeup |

### Timer Path (primary today)

`index.ts` L652: `setInterval(() => heartbeat.tickTimers(), 30_000)`

`tickTimers()` (heartbeat.ts L6774):
1. Iterates all active agents
2. Checks elapsed time since `lastHeartbeatAt` against `policy.intervalSec`
3. Circuit breaker: 4x backoff if last 3 runs were no-ops
4. Calls `enqueueWakeup(source: "timer")` for eligible agents

### Work Pump

`startNextQueuedRunForAgent()` (heartbeat.ts L4565):
- Called at 3 points: after enqueue, after promote, after run complete
- Gets available slots: `maxConcurrentRuns - runningCount`
- Picks queued runs: `ORDER BY createdAt ASC` (FIFO)
- Claims and executes

### Issue Selection on Idle

`autoWakeIdleAgentIfAssignableWork()` (heartbeat.ts L2720):
- Queries issues: `assigneeAgentId = agent, status = 'todo', executionRunId IS NULL, no unresolved blockers`
- **`LIMIT 1` with no ORDER BY** — arbitrary selection
- Enqueues wakeup for the selected issue

## Phase 1: DAG-Aware Issue Ranking

### New Function: `computeCompanyBlockingGraph(companyId)`

Extracted from existing `sweepBlockingChains()` (heartbeat.ts L3076).
Returns the full blocking graph for a company:

```typescript
interface BlockingGraph {
  // Forward: blocker -> issues it blocks
  blockerToBlocked: Map<string, string[]>;
  // Reverse: blocked issue -> its blockers
  blockedToBlockers: Map<string, string[]>;
  // Transitive fan-out per issue (BFS downstream count)
  fanOut: Map<string, number>;
  // Critical path depth per issue (longest chain downstream)
  criticalPathDepth: Map<string, number>;
  // Issue metadata for all nodes
  issueMap: Map<string, IssueMeta>;
}
```

Graph computation:
1. Load all `issueRelations` edges (type = 'blocks') for the company
2. Load issue metadata (id, status, priority, assigneeAgentId)
3. Filter edges: skip where either end is terminal (done/cancelled)
4. Build adjacency lists
5. BFS from each node for transitive fan-out
6. DFS/BFS for critical path depth (longest path from node to any leaf)

Performance: O(V + E) where V = open issues, E = blocking relations.
PAX has ~100-200 active issues, so this is sub-millisecond.

### New Function: `rankReadyIssuesForAgent(agentId)`

```typescript
interface RankedIssue {
  issueId: string;
  priority: string;
  priorityScore: number;     // critical=0, high=1, medium=2, low=3
  fanOut: number;             // transitive dependent count
  criticalPathDepth: number;  // longest downstream chain
  createdAt: Date;            // for tie-breaking
}
```

Implementation:
1. Query all issues assigned to agent where:
   - `status = 'todo'`
   - `executionRunId IS NULL` (not locked)
   - No unresolved blockers (reuse existing NOT EXISTS subquery)
2. Get the company's blocking graph via `computeCompanyBlockingGraph()`
3. For each candidate issue, look up fan-out and critical path depth
4. Sort by: `priorityScore ASC, fanOut DESC, criticalPathDepth DESC, createdAt ASC`
5. Return ranked list

### Modification: `autoWakeIdleAgentIfAssignableWork()`

Before (L2720):
```typescript
const assignable = await db
  .select({ id: issues.id })
  .from(issues)
  .where(/* ...existing filters... */)
  .limit(1);  // arbitrary pick

if (assignable.length === 0) return;

await enqueueWakeup(agentId, {
  source: "on_demand",
  reason: "idle_agent_has_assignable_work",
  // no issueId — agent picks its own
});
```

After:
```typescript
const ranked = await rankReadyIssuesForAgent(agentId);
if (ranked.length === 0) return;

const best = ranked[0];
await enqueueWakeup(agentId, {
  source: "on_demand",
  triggerDetail: "system",
  reason: "idle_agent_has_assignable_work",
  payload: { issueId: best.issueId },
  contextSnapshot: {
    issueId: best.issueId,
    source: "dag_dispatch",
    dagRank: {
      priority: best.priority,
      fanOut: best.fanOut,
      criticalPathDepth: best.criticalPathDepth,
    },
  },
  requestedByActorType: "system",
  requestedByActorId: "dag_dispatch",
});
```

Key improvement: the wakeup now targets a specific issue (the highest
DAG-priority one), and includes DAG metadata so the agent's prompt
context knows *why* this issue was selected.

### Modification: `startNextQueuedRunForAgent()`

Before (L4577):
```typescript
const queuedRuns = await db
  .select()
  .from(heartbeatRuns)
  .where(and(
    eq(heartbeatRuns.agentId, agentId),
    eq(heartbeatRuns.status, "queued"),
  ))
  .orderBy(asc(heartbeatRuns.createdAt))  // FIFO
  .limit(availableSlots);
```

After:
```typescript
const queuedRuns = await db
  .select()
  .from(heartbeatRuns)
  .where(and(
    eq(heartbeatRuns.agentId, agentId),
    eq(heartbeatRuns.status, "queued"),
  ))
  .orderBy(asc(heartbeatRuns.createdAt));

// Re-rank by DAG priority if multiple runs are queued
if (queuedRuns.length > 1) {
  const ranked = await rankQueuedRunsByDagPriority(queuedRuns);
  queuedRuns.splice(0, queuedRuns.length, ...ranked.slice(0, availableSlots));
} else {
  queuedRuns.splice(availableSlots);
}
```

`rankQueuedRunsByDagPriority()` extracts the issueId from each run's
contextSnapshot, looks up DAG rank, and sorts. Runs without an issueId
keep their original FIFO position.

## Phase 2: Timer Demotion

### Change: Heartbeat Policy Defaults

Add `fallbackIntervalSec` to heartbeat policy:

| Role | Current `intervalSec` | New `fallbackIntervalSec` |
|------|----------------------|--------------------------|
| Engineering | 300 (5 min) | 900 (15 min) |
| Leadership | 1800 (30 min) | 3600 (60 min) |

`tickTimers()` uses `fallbackIntervalSec` instead of `intervalSec`. The
shorter `intervalSec` is still used as the minimum spacing between any
two wakeups (to prevent token waste from rapid-fire events).

### Change: Dispatch Source Metrics

Add a counter in `enqueueWakeup()`:

```typescript
const dispatchMetrics = {
  eventSourced: 0,
  timerSourced: 0,
  lastReportedAt: Date.now(),
};
```

In `enqueueWakeup()`:
```typescript
if (source === "timer") dispatchMetrics.timerSourced++;
else dispatchMetrics.eventSourced++;
```

Log summary every 30 minutes:
```
dispatch: 47 event-sourced, 2 timer-sourced (96% event-driven)
```

Target: >95% of actual work runs should be event-sourced.

## Phase 3: Sweep Consolidation (Future)

Extract `sweepBlockingChains()` to share the graph computation with
`rankReadyIssuesForAgent()`. Both need `computeCompanyBlockingGraph()`.
Currently they'll compute it independently, which is fine for the scale
of PAX but should be unified if the issue count grows.

## Invariants Preserved

| Invariant | Mechanism | Changes? |
|-----------|-----------|----------|
| Execution locks | `executionRunId` on issues | No — ranking queries filter `IS NULL` |
| Wakeup coalescing | Dedup map in routes/issues.ts | No — dispatch goes through same path |
| Deferred execution | `deferred_issue_execution` status | No — `enqueueWakeup()` still defers |
| Budget checks | `budgets.getInvocationBlock()` | No — inside `enqueueWakeup()` |
| Agent status | paused/terminated check | No — inside `enqueueWakeup()` |
| Transaction boundaries | `releaseIssueExecutionAndPromote` | No — not modified |
| Circuit breaker | Idle-run backoff in tickTimers | Kept for timer fallback |

## Edge Cases

1. **Concurrent dispatch**: Two agents complete simultaneously, both
   trigger `rankReadyIssuesForAgent()`. Could both select the same
   issue? No — execution locks prevent this. First to `enqueueWakeup()`
   locks the issue; second gets deferred or picks next-best.

2. **DAG cycles**: Issues in a cycle have no well-defined fan-out. Treat
   as `fanOut: 0`. `sweepBlockingChains()` separately detects and alerts
   on cycles.

3. **Empty queue after ranking**: All candidate issues are locked or
   blocked. Agent stays idle. Timer fallback will eventually check.

4. **Priority escalation during run**: Agent working on medium-priority
   issue, critical issue becomes ready. Agent finishes current work,
   `rankReadyIssuesForAgent()` picks the critical issue next. Correct.

5. **Graph computation cost**: BFS over ~200 issues is sub-millisecond.
   Called once per idle-agent-dispatch, not on every timer tick.

## Files Changed

### Phase 1
- `server/src/services/heartbeat.ts`:
  - Add `computeCompanyBlockingGraph()`
  - Add `rankReadyIssuesForAgent()`
  - Add `rankQueuedRunsByDagPriority()`
  - Modify `autoWakeIdleAgentIfAssignableWork()`
  - Modify `startNextQueuedRunForAgent()`

### Phase 2
- `server/src/services/heartbeat.ts`:
  - Add `fallbackIntervalSec` to policy parsing
  - Modify `tickTimers()` to use fallback interval
  - Add dispatch metrics counter + periodic log

### No New Files, No New Dependencies

All changes are within heartbeat.ts. No new npm packages. No database
migrations. No new service files. This is a focused, surgical change
to the scheduling policy within the existing architecture.
