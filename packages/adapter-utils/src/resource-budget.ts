// Resource-aware admission controller for adapter child processes.
//
// Enforces three budget dimensions before a child is spawned:
//   1. Per-adapter-type memory budget (prevents one type starving others).
//   2. Host-wide memory budget (prevents over-subscription of the box).
//   3. Global concurrency cap (defense in depth — belt-and-suspenders over 1+2).
//
// Plus quarantine: when a scope OOM-kills, the monitor marks that adapter
// type as quarantined for a window (default 5 min). New admissions for that
// type queue; other types proceed.
//
// Plus emergency-stop: if the host is critically low on memory, new
// admissions block until headroom recovers.
//
// Callers don't cancel waiters by rejecting their promises — they pass an
// AbortSignal or timeoutMs. Cancelled waiters are removed from the queue
// without leaking reservation counters (they never incremented them).

import { scopeUnitName } from "./memory-cgroup.js";

// ──────────────── types ────────────────

export interface AdapterTypeBudget {
  /** Default reservation (used for budget math) for this adapter type. */
  reservationMB: number;
  /** Default kernel hard cap (systemd MemoryMax) for this adapter type. */
  capMB: number;
  /** Per-type budget ceiling. sum(running reservations for type) ≤ budgetMB. */
  budgetMB: number;
}

export interface BudgetConfig {
  /**
   * Host-wide memory budget in MB. If null, derived at configure() time from
   * /proc/meminfo MemTotal minus OS + server reserves.
   */
  hostBudgetMB: number | null;
  /** Defense-in-depth ceiling on concurrent admitted runs. */
  globalConcurrencyCap: number;
  /** Per-type overrides keyed by adapterType. */
  byAdapterType: Record<string, AdapterTypeBudget>;
  /** Fallback used when adapterType is not in byAdapterType. */
  defaultType: AdapterTypeBudget;
  /**
   * Reserved for the paperclip server itself + OS (subtracted from MemTotal
   * when hostBudgetMB is null).
   */
  serverReserveMB: number;
  osReserveMB: number;
  /** Quarantine duration when an adapter type OOM-kills. */
  quarantineDurationMs: number;
}

export interface ResourceReservation {
  runId: string;
  adapterType: string;
  /** Override the default reservation for this run. */
  reservationMB?: number;
  /** Override the default cap for this run. */
  capMB?: number;
  /** Higher priority admits earlier among same-type waiters. Default 0. */
  priority?: number;
}

export interface ResourceGrant {
  runId: string;
  adapterType: string;
  scopeUnit: string;
  reservationMB: number;
  capMB: number;
  grantedAt: Date;
  release(): void;
  recordPeakMB(peakMB: number): void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BudgetStats {
  host: { budgetMB: number; reservedMB: number; headroomMB: number };
  perType: Record<
    string,
    { budgetMB: number; reservedMB: number; running: number; waiters: number }
  >;
  quarantined: Record<string, { untilMs: number; reason: string }>;
  inFlight: number;
  waiters: number;
  globalConcurrencyCap: number;
  emergencyStoppedUntilMs: number | null;
  emergencyReason: string | null;
}

export interface BackPressureInput {
  /** System MemAvailable, in MB. If below critical threshold, emergency-stop. */
  systemAvailableMB: number;
  /** System MemTotal, in MB. Used to compute % thresholds. */
  systemTotalMB: number;
  /** Per-scope oom_kill counts observed this tick, by adapter type. */
  oomKillsByAdapterType?: Record<string, number>;
}

type AdmitDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "emergency-stopped"
        | "quarantined"
        | "concurrency-cap"
        | "type-budget"
        | "host-budget";
    };

interface Waiter {
  reservation: ResourceReservation;
  reservationMB: number;
  capMB: number;
  priority: number;
  enqueuedAt: number;
  resolve(grant: ResourceGrant): void;
  reject(err: Error): void;
  /** Set by acquireResourceGrant to allow external cancellation. */
  cancel: () => void;
}

// ──────────────── defaults ────────────────

export const DEFAULT_CONFIG: BudgetConfig = {
  hostBudgetMB: null,
  globalConcurrencyCap: Number(process.env.PAPERCLIP_ADAPTER_MAX_CONCURRENT) || 8,
  serverReserveMB: 2048,
  osReserveMB: 1024,
  quarantineDurationMs: 5 * 60 * 1000,
  byAdapterType: {
    claude: { reservationMB: 1536, capMB: 4096, budgetMB: 9216 },
    claude_local: { reservationMB: 1536, capMB: 4096, budgetMB: 9216 },
    codex: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    codex_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    gemini: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    gemini_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    pi: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    pi_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    cursor: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    cursor_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    opencode: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    opencode_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
    hermes_local: { reservationMB: 768, capMB: 3072, budgetMB: 3072 },
  },
  defaultType: { reservationMB: 512, capMB: 2048, budgetMB: 2048 },
};

// Emergency-stop trigger: available memory below this % of total.
const EMERGENCY_STOP_AVAIL_PCT = 5;
// Emergency-stop recovery: available memory above this % of total.
const EMERGENCY_RECOVERY_AVAIL_PCT = 15;

// ──────────────── state ────────────────

let config: BudgetConfig = { ...DEFAULT_CONFIG };
let hostReservedMB = 0;
const typeReservedMB = new Map<string, number>();
const typeRunning = new Map<string, number>();
let inFlight = 0;
const waiters: Waiter[] = [];
const quarantined = new Map<string, { untilMs: number; reason: string }>();
let emergencyStoppedUntilMs: number | null = null;
let emergencyReason: string | null = null;

/** Observer hook so the monitor/logger can record admit/deny events without importing pino. */
export interface BudgetObserver {
  onAdmit?(grant: ResourceGrant, stats: BudgetStats): void;
  onDeny?(
    reservation: ResourceReservation,
    reason: string,
    stats: BudgetStats,
  ): void;
  onRelease?(grant: ResourceGrant, peakMB: number | null, stats: BudgetStats): void;
  onQuarantine?(adapterType: string, untilMs: number, reason: string): void;
  onBackPressure?(prev: boolean, next: boolean, reason: string | null): void;
}
let observer: BudgetObserver = {};

export function setBudgetObserver(o: BudgetObserver): void {
  observer = o;
}

// ──────────────── config ────────────────

function deriveHostBudgetMB(cfg: BudgetConfig): number {
  if (cfg.hostBudgetMB !== null && cfg.hostBudgetMB > 0) return cfg.hostBudgetMB;
  // Lazy-read meminfo to avoid circular imports; fall back to conservative 4 GB.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync("/proc/meminfo", "utf-8");
    const m = raw.match(/^MemTotal:\s+(\d+)/m);
    const totalMB = m ? Math.round(Number(m[1]) / 1024) : 4096;
    return Math.max(512, totalMB - cfg.serverReserveMB - cfg.osReserveMB);
  } catch {
    return 4096;
  }
}

export function configureBudget(partial: Partial<BudgetConfig>): void {
  config = {
    ...config,
    ...partial,
    byAdapterType: { ...config.byAdapterType, ...(partial.byAdapterType ?? {}) },
    defaultType: { ...config.defaultType, ...(partial.defaultType ?? {}) },
  };
}

export function resetBudget(): void {
  config = { ...DEFAULT_CONFIG };
  hostReservedMB = 0;
  typeReservedMB.clear();
  typeRunning.clear();
  inFlight = 0;
  for (const w of waiters) w.reject(new Error("budget reset"));
  waiters.length = 0;
  quarantined.clear();
  emergencyStoppedUntilMs = null;
  emergencyReason = null;
  observer = {};
}

export function getBudgetConfig(): BudgetConfig {
  return { ...config };
}

function typeBudgetFor(adapterType: string): AdapterTypeBudget {
  return config.byAdapterType[adapterType] ?? config.defaultType;
}

// ──────────────── stats ────────────────

export function getBudgetStats(): BudgetStats {
  const hostBudgetMB = deriveHostBudgetMB(config);
  const perType: BudgetStats["perType"] = {};
  // Include every adapter type that has activity or a configured budget.
  const allTypes = new Set<string>([
    ...Object.keys(config.byAdapterType),
    ...typeReservedMB.keys(),
    ...typeRunning.keys(),
  ]);
  for (const t of allTypes) {
    perType[t] = {
      budgetMB: typeBudgetFor(t).budgetMB,
      reservedMB: typeReservedMB.get(t) ?? 0,
      running: typeRunning.get(t) ?? 0,
      waiters: waiters.filter((w) => w.reservation.adapterType === t).length,
    };
  }
  const quarantinedOut: BudgetStats["quarantined"] = {};
  for (const [t, q] of quarantined) {
    quarantinedOut[t] = { untilMs: q.untilMs, reason: q.reason };
  }
  return {
    host: {
      budgetMB: hostBudgetMB,
      reservedMB: hostReservedMB,
      headroomMB: Math.max(0, hostBudgetMB - hostReservedMB),
    },
    perType,
    quarantined: quarantinedOut,
    inFlight,
    waiters: waiters.length,
    globalConcurrencyCap: config.globalConcurrencyCap,
    emergencyStoppedUntilMs,
    emergencyReason,
  };
}

// ──────────────── admission ────────────────

function canAdmit(
  adapterType: string,
  reservationMB: number,
  now: number,
): AdmitDecision {
  if (emergencyStoppedUntilMs !== null && emergencyStoppedUntilMs > now) {
    return { ok: false, reason: "emergency-stopped" };
  }
  const q = quarantined.get(adapterType);
  if (q && q.untilMs > now) return { ok: false, reason: "quarantined" };
  if (inFlight >= config.globalConcurrencyCap) {
    return { ok: false, reason: "concurrency-cap" };
  }
  const budget = typeBudgetFor(adapterType);
  const typeReserved = typeReservedMB.get(adapterType) ?? 0;
  if (typeReserved + reservationMB > budget.budgetMB) {
    return { ok: false, reason: "type-budget" };
  }
  const hostBudgetMB = deriveHostBudgetMB(config);
  if (hostReservedMB + reservationMB > hostBudgetMB) {
    return { ok: false, reason: "host-budget" };
  }
  return { ok: true };
}

function grantReservation(
  r: ResourceReservation,
  reservationMB: number,
  capMB: number,
): ResourceGrant {
  const adapterType = r.adapterType;
  hostReservedMB += reservationMB;
  typeReservedMB.set(adapterType, (typeReservedMB.get(adapterType) ?? 0) + reservationMB);
  typeRunning.set(adapterType, (typeRunning.get(adapterType) ?? 0) + 1);
  inFlight++;

  const scopeUnit = scopeUnitName(r.runId);
  let released = false;
  let observedPeakMB: number | null = null;

  const grant: ResourceGrant = {
    runId: r.runId,
    adapterType,
    scopeUnit,
    reservationMB,
    capMB,
    grantedAt: new Date(),
    release() {
      if (released) return;
      released = true;
      hostReservedMB = Math.max(0, hostReservedMB - reservationMB);
      typeReservedMB.set(
        adapterType,
        Math.max(0, (typeReservedMB.get(adapterType) ?? 0) - reservationMB),
      );
      typeRunning.set(
        adapterType,
        Math.max(0, (typeRunning.get(adapterType) ?? 0) - 1),
      );
      inFlight = Math.max(0, inFlight - 1);
      observer.onRelease?.(grant, observedPeakMB, getBudgetStats());
      drainQueue();
    },
    recordPeakMB(peakMB: number) {
      if (observedPeakMB === null || peakMB > observedPeakMB) observedPeakMB = peakMB;
    },
  };
  observer.onAdmit?.(grant, getBudgetStats());
  return grant;
}

function resolveReservationSize(r: ResourceReservation): { reservationMB: number; capMB: number } {
  const budget = typeBudgetFor(r.adapterType);
  return {
    reservationMB: r.reservationMB ?? budget.reservationMB,
    capMB: r.capMB ?? budget.capMB,
  };
}

/**
 * Attempt to admit waiters from the front of the queue. Stops at the first
 * waiter whose admission would be denied *for a reason other than budget*
 * (emergency-stop/concurrency), so that fast passes of small-footprint
 * waiters behind a blocked large claude still get served when their type
 * budget allows. Iterates safely: we build a list of waiters to admit first,
 * then splice them out and resolve.
 */
function drainQueue(): void {
  if (waiters.length === 0) return;
  const now = Date.now();
  const toAdmit: Waiter[] = [];
  for (const w of waiters) {
    const decision = canAdmit(w.reservation.adapterType, w.reservationMB, now);
    if (decision.ok) {
      toAdmit.push(w);
      // Tentatively reserve so later admissions in this drain see the new state.
      hostReservedMB += w.reservationMB;
      typeReservedMB.set(
        w.reservation.adapterType,
        (typeReservedMB.get(w.reservation.adapterType) ?? 0) + w.reservationMB,
      );
      inFlight++;
      if (toAdmit.length > waiters.length) break;
    } else if (decision.reason === "emergency-stopped" || decision.reason === "concurrency-cap") {
      // Global gates — stop draining entirely.
      break;
    }
    // Type-budget or host-budget or quarantined: skip this waiter but keep
    // trying later waiters (different type may fit).
  }
  // Roll back the tentative reserves before granting (grantReservation
  // will re-apply them for real — otherwise we'd double-count).
  for (const w of toAdmit) {
    hostReservedMB -= w.reservationMB;
    typeReservedMB.set(
      w.reservation.adapterType,
      (typeReservedMB.get(w.reservation.adapterType) ?? 0) - w.reservationMB,
    );
    inFlight--;
  }
  for (const w of toAdmit) {
    const idx = waiters.indexOf(w);
    if (idx >= 0) waiters.splice(idx, 1);
    const grant = grantReservation(w.reservation, w.reservationMB, w.capMB);
    w.resolve(grant);
  }
}

export async function acquireResourceGrant(
  reservation: ResourceReservation,
  opts?: AcquireOptions,
): Promise<ResourceGrant> {
  const { reservationMB, capMB } = resolveReservationSize(reservation);
  const now = Date.now();
  const decision = canAdmit(reservation.adapterType, reservationMB, now);
  if (decision.ok) {
    return grantReservation(reservation, reservationMB, capMB);
  }
  observer.onDeny?.(reservation, decision.reason, getBudgetStats());

  // Enqueue; resolve when drainQueue picks us.
  return new Promise<ResourceGrant>((resolve, reject) => {
    let settled = false;
    const priority = reservation.priority ?? 0;
    const waiter: Waiter = {
      reservation,
      reservationMB,
      capMB,
      priority,
      enqueuedAt: Date.now(),
      resolve: (g) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(g);
      },
      reject: (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        cleanup();
        reject(new Error("resource-budget: acquisition aborted"));
      },
    };
    // Insert by (priority desc, enqueuedAt asc).
    let insertAt = waiters.length;
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].priority < priority) {
        insertAt = i;
        break;
      }
    }
    waiters.splice(insertAt, 0, waiter);

    // Timeout
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        cleanup();
        reject(new Error(`resource-budget: timeout after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    // Abort
    const signal = opts?.signal;
    const onAbort = () => waiter.cancel();
    if (signal) {
      if (signal.aborted) {
        waiter.cancel();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  });
}

// ──────────────── quarantine / back-pressure ────────────────

export function quarantineAdapterType(
  adapterType: string,
  durationMs: number,
  reason: string,
): void {
  const untilMs = Date.now() + durationMs;
  quarantined.set(adapterType, { untilMs, reason });
  observer.onQuarantine?.(adapterType, untilMs, reason);
}

export function clearExpiredQuarantines(now = Date.now()): void {
  for (const [t, q] of quarantined) {
    if (q.untilMs <= now) quarantined.delete(t);
  }
}

/**
 * Called by the resource monitor each tick. Updates emergency-stop state
 * and quarantines any adapter types whose scopes OOM-killed since the last
 * tick. Drains the wait queue after adjustments.
 */
export function applyBackPressure(input: BackPressureInput): void {
  const now = Date.now();
  clearExpiredQuarantines(now);

  const availPct = input.systemTotalMB > 0
    ? (input.systemAvailableMB / input.systemTotalMB) * 100
    : 100;

  const wasStopped = emergencyStoppedUntilMs !== null && emergencyStoppedUntilMs > now;
  if (availPct < EMERGENCY_STOP_AVAIL_PCT) {
    emergencyStoppedUntilMs = now + 30_000; // re-evaluate each tick
    emergencyReason = `system MemAvailable ${Math.round(availPct)}% < ${EMERGENCY_STOP_AVAIL_PCT}%`;
    if (!wasStopped) observer.onBackPressure?.(false, true, emergencyReason);
  } else if (availPct >= EMERGENCY_RECOVERY_AVAIL_PCT) {
    if (wasStopped) observer.onBackPressure?.(true, false, null);
    emergencyStoppedUntilMs = null;
    emergencyReason = null;
  }
  // 5–15% is a hysteresis band — leave state unchanged.

  // Quarantine types with fresh OOM kills.
  if (input.oomKillsByAdapterType) {
    for (const [type, count] of Object.entries(input.oomKillsByAdapterType)) {
      if (count > 0) {
        quarantineAdapterType(
          type,
          config.quarantineDurationMs,
          `oom-kill observed (+${count} since last tick)`,
        );
      }
    }
  }

  drainQueue();
}
