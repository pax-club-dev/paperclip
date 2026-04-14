// Periodic sampler for memory, CPU, FD, PID, disk, cgroup state.
//
// Replaces the earlier memory-monitor: now covers every resource dimension
// that could hang the server. Each tick (called from index.ts at ~30s
// cadence) it:
//   - Reads /proc + /sys/fs/cgroup for system + per-scope state.
//   - Walks the server's own process tree (plugin workers use fork(), not
//     scopes — tree walk stays the authoritative source for them).
//   - Computes per-adapter-type OOM-kill deltas, feeds them to
//     resource-budget.applyBackPressure() which may quarantine an offending
//     type or emergency-stop admission on low system memory.
//   - Emits one pino record per tick (debug) + info at threshold transitions
//     and a periodic info baseline every ~10 minutes.
//
// The snapshot shape is ResourceSnapshot; adapter entries come from the
// `runningProcesses` map in adapters/utils.ts which stores the grant from
// acquireResourceGrant — this gives deterministic scope unit names so cgroup
// reads never race with /proc/<pid>/cgroup.

import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  readCgroupCpuStat,
  readCgroupMemory,
  readCgroupPids,
  readDiskUsage,
  readLoadAvg,
  readSystemFdUsage,
  readSystemMemory,
  readSystemPidUsage,
  scopeCgroupPath,
  type CgroupCpuStat,
} from "@paperclipai/adapter-utils/proc-introspection";
import {
  applyBackPressure,
  getBudgetStats,
} from "@paperclipai/adapter-utils/resource-budget";
import { runningProcesses } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";

const WARN_SYSTEM_PERCENT = 80;
const CRITICAL_SYSTEM_PERCENT = 90;
const INFO_LOG_EVERY_N_TICKS = 20;
const DISK_MOUNTS = ["/", "/tmp", process.env.HOME ?? "/home"];

function readChildRssMB(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    const m = status.match(/^VmRSS:\s+(\d+)/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function readCommForPid(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
  } catch {
    return "?";
  }
}

function readDirectChildren(pid: number): number[] {
  const out = new Set<number>();
  try {
    const tasks = fs.readdirSync(`/proc/${pid}/task`);
    for (const tid of tasks) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf-8");
        for (const part of raw.trim().split(/\s+/)) {
          if (!part) continue;
          const n = Number.parseInt(part, 10);
          if (Number.isFinite(n) && n > 0) out.add(n);
        }
      } catch {
        // task may have exited between readdir and read
      }
    }
  } catch {
    // pid gone
  }
  return [...out];
}

function walkDescendants(
  rootPid: number,
  maxNodes = 500,
): { totalRssMB: number; top: Array<{ pid: number; rssMB: number; comm: string }> } {
  const seen = new Set<number>();
  const entries: Array<{ pid: number; rssMB: number; comm: string }> = [];
  const stack = readDirectChildren(rootPid);
  while (stack.length && seen.size < maxNodes) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const rss = readChildRssMB(pid);
    if (rss !== null) entries.push({ pid, rssMB: rss, comm: readCommForPid(pid) });
    for (const child of readDirectChildren(pid)) {
      if (!seen.has(child)) stack.push(child);
    }
  }
  return {
    totalRssMB: entries.reduce((s, e) => s + e.rssMB, 0),
    top: entries.sort((a, b) => b.rssMB - a.rssMB).slice(0, 10),
  };
}

export interface ResourceSnapshot {
  process: {
    rssMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    arrayBuffersMB: number;
  };
  system: {
    memory: {
      usedPercent: number;
      availableMB: number;
      totalMB: number;
      swapUsedMB: number;
      swapTotalMB: number;
    };
    load: {
      oneMin: number;
      fiveMin: number;
      fifteenMin: number;
      runnable: number;
      total: number;
      cpuCount: number;
    } | null;
    fds: { used: number; max: number; percent: number } | null;
    pids: { count: number; max: number; percent: number } | null;
    disk: Array<{
      mount: string;
      bytesUsedPct: number;
      inodesUsedPct: number;
      availableMB: number;
    }>;
  };
  adapters: Array<{
    runId: string;
    adapterType: string | null;
    pid: number;
    scope: {
      unitName: string;
      memoryCurrentMB: number;
      memoryMaxMB: number | null;
      swapCurrentMB: number;
      oomKillCount: number;
      oomKillDelta: number;
      pidsCurrent: number;
      cpuThrottledUsec: number;
    } | null;
    treeRssMB: number;
    reservationMB: number | null;
    capMB: number | null;
  }>;
  budget: ReturnType<typeof getBudgetStats>;
  serverTree: {
    rssMB: number;
    topChildren: Array<{ pid: number; rssMB: number; comm: string }>;
  };
}

// Per-adapter cumulative oom_kill tracking across ticks so we can compute deltas.
type OomState = { lastCount: number };
const oomTrackerByRunId = new Map<string, OomState>();
// Per-adapter cpu usage tracking so we can compute throttled delta across ticks.
const cpuTrackerByRunId = new Map<string, CgroupCpuStat>();

// Scope-reaper state. A leaked scope is one whose unit name is not claimed by
// any live `runningProcesses` entry. Causes: child.kill() only signals the
// direct descendant (bwrap → script → claude), so forked grandchildren survive
// and keep the cgroup populated after `runningProcesses.delete()` fires on
// child close. Result: memory accumulates in siblings of the paperclip outer
// scope until the outer MemoryMax kills the whole server.
//
// The reaper issues `systemctl --user stop <unit>` for any leaked scope. systemd
// sends SIGTERM to every task in the cgroup, then SIGKILL after a grace period.
const UID = process.getuid?.() ?? 0;
const APP_SLICE_DIR = `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/app.slice`;
const REAP_COOLDOWN_MS = 60_000;
const reapCooldown = new Map<string, number>();

function listPaperclipScopeUnits(): string[] {
  try {
    return fs
      .readdirSync(APP_SLICE_DIR)
      .filter((name) => name.startsWith("paperclip-run-") && name.endsWith(".scope"));
  } catch {
    return [];
  }
}

function countScopeProcs(unitName: string): number {
  const raw = (() => {
    try {
      return fs.readFileSync(`${APP_SLICE_DIR}/${unitName}/cgroup.procs`, "utf-8");
    } catch {
      return null;
    }
  })();
  if (!raw) return 0;
  let n = 0;
  for (const line of raw.split("\n")) if (line.trim()) n++;
  return n;
}

function reapLeakedScopes(activeUnits: Set<string>): void {
  const now = Date.now();
  const units = listPaperclipScopeUnits();
  for (const unit of units) {
    if (activeUnits.has(unit)) continue;
    const procCount = countScopeProcs(unit);
    if (procCount === 0) continue; // already empty — systemd will GC the unit
    const lastReap = reapCooldown.get(unit) ?? 0;
    if (now - lastReap < REAP_COOLDOWN_MS) continue;
    reapCooldown.set(unit, now);

    logger.warn(
      { unit, procCount },
      `resource-monitor: reaping leaked scope ${unit} (${procCount} task(s), not in runningProcesses)`,
    );
    try {
      const child = spawn("systemctl", ["--user", "stop", unit], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", (err) => {
        logger.warn({ err, unit }, "resource-monitor: failed to spawn systemctl stop for leaked scope");
      });
    } catch (err) {
      logger.warn({ err, unit }, "resource-monitor: exception spawning systemctl stop for leaked scope");
    }
  }

  // GC cooldown entries for units that no longer exist
  const existing = new Set(units);
  for (const unit of reapCooldown.keys()) {
    if (!existing.has(unit)) reapCooldown.delete(unit);
  }
}

export function createResourceMonitor() {
  let lastLevel: "ok" | "warn" | "critical" = "ok";
  let tickCount = 0;

  function sample(): ResourceSnapshot {
    tickCount++;

    const mem = process.memoryUsage();
    const processMem = {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
    };

    const systemMem = readSystemMemory();
    const load = readLoadAvg();
    const fds = readSystemFdUsage();
    const pids = readSystemPidUsage();
    const disk: ResourceSnapshot["system"]["disk"] = [];
    const seenMounts = new Set<string>();
    for (const m of DISK_MOUNTS) {
      if (seenMounts.has(m)) continue;
      const d = readDiskUsage(m);
      if (d) {
        disk.push({
          mount: d.mount,
          bytesUsedPct: d.bytesUsedPct,
          inodesUsedPct: d.inodesUsedPct,
          availableMB: d.availableMB,
        });
        seenMounts.add(m);
      }
    }

    const adapters: ResourceSnapshot["adapters"] = [];
    const oomDeltasByType: Record<string, number> = {};
    const activeRunIds = new Set<string>();
    const activeScopeUnits = new Set<string>();
    const topProcessMap = new Map<number, { pid: number; rssMB: number; comm: string }>();

    runningProcesses.forEach((entry, runId) => {
      const pid = entry.child.pid;
      if (!pid) return;
      activeRunIds.add(runId);
      if (entry.scopeUnit) activeScopeUnits.add(entry.scopeUnit);
      const descendants = walkDescendants(pid);
      const selfRss = readChildRssMB(pid) ?? 0;
      const treeRssMB = selfRss + descendants.totalRssMB;
      for (const d of descendants.top) topProcessMap.set(d.pid, d);

      let scope: ResourceSnapshot["adapters"][number]["scope"] = null;
      if (entry.scopeUnit) {
        const cgPath = scopeCgroupPath(entry.scopeUnit);
        const cgMem = readCgroupMemory(cgPath);
        const cgPids = readCgroupPids(cgPath);
        const cgCpu = readCgroupCpuStat(cgPath);
        if (cgMem) {
          const tracker = oomTrackerByRunId.get(runId) ?? { lastCount: cgMem.oomKillCount };
          const delta = Math.max(0, cgMem.oomKillCount - tracker.lastCount);
          tracker.lastCount = cgMem.oomKillCount;
          oomTrackerByRunId.set(runId, tracker);
          if (delta > 0 && entry.adapterType) {
            oomDeltasByType[entry.adapterType] =
              (oomDeltasByType[entry.adapterType] ?? 0) + delta;
          }

          let throttledDeltaUsec = 0;
          if (cgCpu) {
            const prev = cpuTrackerByRunId.get(runId);
            throttledDeltaUsec = prev
              ? Math.max(0, cgCpu.throttledUsec - prev.throttledUsec)
              : 0;
            cpuTrackerByRunId.set(runId, cgCpu);
          }

          scope = {
            unitName: entry.scopeUnit,
            memoryCurrentMB: cgMem.currentMB,
            memoryMaxMB: cgMem.maxMB,
            swapCurrentMB: cgMem.swapCurrentMB,
            oomKillCount: cgMem.oomKillCount,
            oomKillDelta: delta,
            pidsCurrent: cgPids?.current ?? 0,
            cpuThrottledUsec: throttledDeltaUsec,
          };
        }
      }

      adapters.push({
        runId,
        adapterType: entry.adapterType ?? null,
        pid,
        scope,
        treeRssMB,
        reservationMB: entry.reservationMB ?? null,
        capMB: entry.capMB ?? null,
      });
    });

    // Forget trackers for runs that have ended to prevent unbounded growth.
    for (const runId of oomTrackerByRunId.keys()) {
      if (!activeRunIds.has(runId)) oomTrackerByRunId.delete(runId);
    }
    for (const runId of cpuTrackerByRunId.keys()) {
      if (!activeRunIds.has(runId)) cpuTrackerByRunId.delete(runId);
    }

    // Reap leaked scopes — cgroup units still hosting tasks after their
    // runningProcesses entry has been deleted (child.on("close") fired but
    // grandchildren from script/bwrap forks never got SIGTERM). systemd --user
    // stop kills every task in the scope and releases its memory accounting.
    reapLeakedScopes(activeScopeUnits);

    // Server's own tree — keeps plugin-worker RSS visible (fork(), not a scope).
    const serverDescendants = walkDescendants(process.pid);
    for (const d of serverDescendants.top) topProcessMap.set(d.pid, d);
    const serverTreeRssMB = processMem.rssMB + serverDescendants.totalRssMB;
    const topChildren = [...topProcessMap.values()]
      .sort((a, b) => b.rssMB - a.rssMB)
      .slice(0, 10);

    // Feed back-pressure — may quarantine types or emergency-stop.
    applyBackPressure({
      systemAvailableMB: systemMem.availableMB,
      systemTotalMB: systemMem.totalMB,
      oomKillsByAdapterType:
        Object.keys(oomDeltasByType).length > 0 ? oomDeltasByType : undefined,
    });

    const budget = getBudgetStats();

    const snapshot: ResourceSnapshot = {
      process: processMem,
      system: {
        memory: {
          usedPercent: systemMem.usedPercent,
          availableMB: systemMem.availableMB,
          totalMB: systemMem.totalMB,
          swapUsedMB: systemMem.swapUsedMB,
          swapTotalMB: systemMem.swapTotalMB,
        },
        load,
        fds,
        pids,
        disk,
      },
      adapters,
      budget,
      serverTree: { rssMB: serverTreeRssMB, topChildren },
    };

    // Severity classification
    const combinedRssMB =
      serverTreeRssMB + adapters.reduce((s, a) => s + a.treeRssMB, 0);
    if (systemMem.usedPercent >= CRITICAL_SYSTEM_PERCENT) {
      logger.error(
        snapshot,
        `resource-monitor: CRITICAL system ${systemMem.usedPercent}% (${systemMem.availableMB}MB avail) — server ${serverTreeRssMB}MB, ${adapters.length} adapter(s)`,
      );
      lastLevel = "critical";
    } else if (systemMem.usedPercent >= WARN_SYSTEM_PERCENT || combinedRssMB >= 2048) {
      logger.warn(
        snapshot,
        `resource-monitor: elevated — system ${systemMem.usedPercent}%, server ${serverTreeRssMB}MB, ${adapters.length} adapter(s)`,
      );
      lastLevel = "warn";
    } else {
      if (lastLevel !== "ok") {
        logger.info(snapshot, `resource-monitor: recovered — system ${systemMem.usedPercent}%`);
      }
      lastLevel = "ok";
    }

    if (tickCount % INFO_LOG_EVERY_N_TICKS === 0) {
      logger.info(
        snapshot,
        `resource-monitor: periodic — system ${systemMem.usedPercent}% (${systemMem.availableMB}MB avail), server ${serverTreeRssMB}MB, ${adapters.length} adapter(s), budget inFlight=${budget.inFlight} waiters=${budget.waiters}`,
      );
    }

    logger.debug(snapshot, "resource-monitor: tick");
    return snapshot;
  }

  function logStartup(): void {
    const snapshot = sample();
    logger.info(
      snapshot,
      `resource-monitor: startup — system ${snapshot.system.memory.usedPercent}% (${snapshot.system.memory.availableMB}MB of ${snapshot.system.memory.totalMB}MB avail), server ${snapshot.serverTree.rssMB}MB`,
    );
  }

  return { sample, logStartup };
}
