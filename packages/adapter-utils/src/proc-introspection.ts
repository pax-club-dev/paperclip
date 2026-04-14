// Read-only helpers for /proc and /sys/fs/cgroup introspection.
//
// All functions return null on any failure (missing file, parse error, EACCES)
// so callers can degrade gracefully on non-Linux hosts or cgroup-v1 systems.
// These are hot-path helpers called every monitor tick per adapter — they
// must not throw and must not allocate excessively.

import fs from "node:fs";
import os from "node:os";

const MB = 1024 * 1024;
const toMB = (bytes: number): number => Math.round(bytes / MB);

function readTextSync(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function parseFirstNumber(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the cgroup v2 path for a systemd-run --user --scope unit.
 * Matches the systemd hierarchy on cgroup v2 unified hosts.
 */
export function scopeCgroupPath(unitName: string, uid: number = process.getuid?.() ?? 0): string {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unitName}`;
}

export interface CgroupMemory {
  currentMB: number;
  maxMB: number | null;          // null if "max" (unlimited)
  swapCurrentMB: number;
  oomKillCount: number;
  oomCount: number;
}

export function readCgroupMemory(cgroupPath: string): CgroupMemory | null {
  const currentRaw = readTextSync(`${cgroupPath}/memory.current`);
  const current = parseFirstNumber(currentRaw);
  if (current === null) return null;

  const maxRaw = readTextSync(`${cgroupPath}/memory.max`)?.trim();
  const maxMB = !maxRaw || maxRaw === "max" ? null : toMB(Number(maxRaw));

  const swapRaw = readTextSync(`${cgroupPath}/memory.swap.current`);
  const swapCurrent = parseFirstNumber(swapRaw) ?? 0;

  let oomKillCount = 0;
  let oomCount = 0;
  const eventsRaw = readTextSync(`${cgroupPath}/memory.events`);
  if (eventsRaw) {
    for (const line of eventsRaw.split("\n")) {
      const [key, value] = line.trim().split(/\s+/);
      if (!key) continue;
      if (key === "oom_kill") oomKillCount = Number(value) || 0;
      else if (key === "oom") oomCount = Number(value) || 0;
    }
  }

  return {
    currentMB: toMB(current),
    maxMB,
    swapCurrentMB: toMB(swapCurrent),
    oomKillCount,
    oomCount,
  };
}

export interface CgroupPids {
  current: number;
  max: number | null;
}

export function readCgroupPids(cgroupPath: string): CgroupPids | null {
  const currentRaw = readTextSync(`${cgroupPath}/pids.current`);
  const current = parseFirstNumber(currentRaw);
  if (current === null) return null;
  const maxRaw = readTextSync(`${cgroupPath}/pids.max`)?.trim();
  const max = !maxRaw || maxRaw === "max" ? null : Number(maxRaw);
  return { current, max: max !== null && Number.isFinite(max) ? max : null };
}

export interface CgroupCpuStat {
  usageUsec: number;
  userUsec: number;
  systemUsec: number;
  throttledUsec: number;
  nrThrottled: number;
}

export function readCgroupCpuStat(cgroupPath: string): CgroupCpuStat | null {
  const raw = readTextSync(`${cgroupPath}/cpu.stat`);
  if (!raw) return null;
  const out: CgroupCpuStat = {
    usageUsec: 0,
    userUsec: 0,
    systemUsec: 0,
    throttledUsec: 0,
    nrThrottled: 0,
  };
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (key === "usage_usec") out.usageUsec = n;
    else if (key === "user_usec") out.userUsec = n;
    else if (key === "system_usec") out.systemUsec = n;
    else if (key === "throttled_usec") out.throttledUsec = n;
    else if (key === "nr_throttled") out.nrThrottled = n;
  }
  return out;
}

export interface LoadAvg {
  oneMin: number;
  fiveMin: number;
  fifteenMin: number;
  runnable: number;
  total: number;
  cpuCount: number;
}

export function readLoadAvg(): LoadAvg | null {
  const raw = readTextSync("/proc/loadavg");
  if (!raw) {
    // Fallback to os.loadavg() for non-Linux
    const [oneMin, fiveMin, fifteenMin] = os.loadavg();
    if (oneMin === undefined) return null;
    return {
      oneMin,
      fiveMin,
      fifteenMin,
      runnable: 0,
      total: 0,
      cpuCount: os.cpus().length,
    };
  }
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [runnable, total] = parts[3].split("/").map(Number);
  return {
    oneMin: Number(parts[0]),
    fiveMin: Number(parts[1]),
    fifteenMin: Number(parts[2]),
    runnable: runnable || 0,
    total: total || 0,
    cpuCount: os.cpus().length,
  };
}

export interface FdUsage {
  used: number;
  max: number;
  percent: number;
}

export function readSystemFdUsage(): FdUsage | null {
  const raw = readTextSync("/proc/sys/fs/file-nr");
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || !parts.every(Number.isFinite)) return null;
  const [allocated, , max] = parts;
  const used = allocated; // column 0: allocated; column 1: always 0 on 2.6+
  return {
    used,
    max,
    percent: max > 0 ? Math.round((used / max) * 100) : 0,
  };
}

export function readProcessFdCount(pid: number): number | null {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

export interface PidUsage {
  count: number;
  max: number;
  percent: number;
}

export function readSystemPidUsage(): PidUsage | null {
  const maxRaw = readTextSync("/proc/sys/kernel/pid_max");
  const max = parseFirstNumber(maxRaw);
  if (max === null) return null;
  let count = 0;
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (/^\d+$/.test(entry)) count++;
    }
  } catch {
    return null;
  }
  return { count, max, percent: max > 0 ? Math.round((count / max) * 100) : 0 };
}

export interface DiskUsage {
  mount: string;
  bytesUsedPct: number;
  inodesUsedPct: number;
  availableMB: number;
  availableInodes: number;
}

/**
 * Read disk usage for a filesystem path via fs.statfsSync (Node 18.15+).
 * Returns null when statfs is unsupported or path is unreachable.
 */
export function readDiskUsage(mountPath: string): DiskUsage | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => {
    bavail: bigint | number;
    bfree: bigint | number;
    blocks: bigint | number;
    bsize: bigint | number;
    favail: bigint | number;
    ffree: bigint | number;
    files: bigint | number;
  } }).statfsSync;
  if (!statfs) return null;
  try {
    const s = statfs(mountPath);
    const toNum = (v: bigint | number): number => (typeof v === "bigint" ? Number(v) : v);
    const bsize = toNum(s.bsize);
    const blocks = toNum(s.blocks);
    const bfree = toNum(s.bfree);
    const bavail = toNum(s.bavail);
    const files = toNum(s.files);
    const favail = toNum(s.favail);
    const used = blocks - bfree;
    const bytesUsedPct = blocks > 0 ? Math.round((used / blocks) * 100) : 0;
    const inodesUsed = files - favail;
    const inodesUsedPct = files > 0 ? Math.round((inodesUsed / files) * 100) : 0;
    return {
      mount: mountPath,
      bytesUsedPct,
      inodesUsedPct,
      availableMB: toMB(bavail * bsize),
      availableInodes: favail,
    };
  } catch {
    return null;
  }
}

export interface SystemMemory {
  totalMB: number;
  availableMB: number;
  usedPercent: number;
  swapTotalMB: number;
  swapUsedMB: number;
}

export function readSystemMemory(): SystemMemory {
  const raw = readTextSync("/proc/meminfo");
  if (!raw) {
    const totalMB = toMB(os.totalmem());
    const freeMB = toMB(os.freemem());
    return {
      totalMB,
      availableMB: freeMB,
      usedPercent: totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0,
      swapTotalMB: 0,
      swapUsedMB: 0,
    };
  }
  const field = (key: string): number => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) / 1024 : 0; // kB → MB
  };
  const totalMB = field("MemTotal");
  const availableMB = field("MemAvailable");
  const swapTotalMB = field("SwapTotal");
  const swapFreeMB = field("SwapFree");
  return {
    totalMB: Math.round(totalMB),
    availableMB: Math.round(availableMB),
    usedPercent: totalMB > 0 ? Math.round(((totalMB - availableMB) / totalMB) * 100) : 0,
    swapTotalMB: Math.round(swapTotalMB),
    swapUsedMB: Math.round(Math.max(0, swapTotalMB - swapFreeMB)),
  };
}
