import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireResourceGrant,
  applyBackPressure,
  configureBudget,
  getBudgetStats,
  quarantineAdapterType,
  resetBudget,
  setBudgetObserver,
  type BudgetObserver,
  type ResourceGrant,
} from "./resource-budget.js";

function tightBudget() {
  configureBudget({
    hostBudgetMB: 4096,
    globalConcurrencyCap: 4,
    byAdapterType: {
      claude_local: { reservationMB: 1000, capMB: 2048, budgetMB: 2000 },
      codex_local: { reservationMB: 500, capMB: 1024, budgetMB: 1000 },
    },
    defaultType: { reservationMB: 500, capMB: 1024, budgetMB: 1000 },
  });
}

describe("resource-budget", () => {
  beforeEach(() => {
    resetBudget();
    tightBudget();
  });

  afterEach(() => {
    resetBudget();
  });

  it("admits within budget and tracks stats", async () => {
    const grant = await acquireResourceGrant({
      runId: "r1",
      adapterType: "claude_local",
    });
    expect(grant.reservationMB).toBe(1000);
    expect(grant.capMB).toBe(2048);
    expect(grant.scopeUnit).toBe("paperclip-run-r1.scope");

    const stats = getBudgetStats();
    expect(stats.inFlight).toBe(1);
    expect(stats.host.reservedMB).toBe(1000);
    expect(stats.perType.claude_local.reservedMB).toBe(1000);
    expect(stats.perType.claude_local.running).toBe(1);

    grant.release();
    const after = getBudgetStats();
    expect(after.inFlight).toBe(0);
    expect(after.host.reservedMB).toBe(0);
  });

  it("release is idempotent", async () => {
    const grant = await acquireResourceGrant({
      runId: "r1",
      adapterType: "claude_local",
    });
    grant.release();
    grant.release(); // second release is a no-op
    const stats = getBudgetStats();
    expect(stats.inFlight).toBe(0);
    expect(stats.host.reservedMB).toBe(0);
  });

  it("queues when type budget exhausted, admits on release", async () => {
    const g1 = await acquireResourceGrant({
      runId: "r1",
      adapterType: "claude_local",
    });
    // Second claude doesn't fit (budget 2000, one claude at 1000 leaves 1000;
    // a second claude needs 1000 — it fits. Use 3rd to force queue.)
    const g2 = await acquireResourceGrant({
      runId: "r2",
      adapterType: "claude_local",
    });

    let g3: ResourceGrant | null = null;
    const g3Promise = acquireResourceGrant({
      runId: "r3",
      adapterType: "claude_local",
    }).then((g) => {
      g3 = g;
      return g;
    });
    // g3 should wait.
    await new Promise((r) => setTimeout(r, 10));
    expect(g3).toBeNull();
    expect(getBudgetStats().waiters).toBe(1);

    g1.release();
    await g3Promise;
    expect(g3).not.toBeNull();
    expect(getBudgetStats().waiters).toBe(0);
    g2.release();
    g3!.release();
  });

  it("does not starve other adapter types — codex gets admitted while claude blocked", async () => {
    // Fill claude budget: 2 runs × 1000 MB = 2000 MB (at limit).
    const c1 = await acquireResourceGrant({
      runId: "c1",
      adapterType: "claude_local",
    });
    const c2 = await acquireResourceGrant({
      runId: "c2",
      adapterType: "claude_local",
    });
    // Third claude has to wait.
    const c3p = acquireResourceGrant({
      runId: "c3",
      adapterType: "claude_local",
    });

    // Codex should be admitted immediately despite claude queue.
    const x1 = await acquireResourceGrant({
      runId: "x1",
      adapterType: "codex_local",
    });
    expect(x1.adapterType).toBe("codex_local");

    c1.release();
    const c3 = await c3p;
    c2.release();
    c3.release();
    x1.release();
  });

  it("denies when host budget exhausted even if type budget has room", async () => {
    // Configure host tight enough that 2 codex fit but 3 don't (codex type
    // budget allows 2 at 500 each — same as host 4096 with others consuming).
    resetBudget();
    configureBudget({
      hostBudgetMB: 1100,
      globalConcurrencyCap: 10,
      byAdapterType: {
        codex_local: { reservationMB: 500, capMB: 1024, budgetMB: 5000 },
      },
      defaultType: { reservationMB: 500, capMB: 1024, budgetMB: 5000 },
    });
    const g1 = await acquireResourceGrant({
      runId: "r1",
      adapterType: "codex_local",
    });
    const g2 = await acquireResourceGrant({
      runId: "r2",
      adapterType: "codex_local",
    });
    let g3: ResourceGrant | null = null;
    const g3p = acquireResourceGrant({
      runId: "r3",
      adapterType: "codex_local",
    }).then((g) => {
      g3 = g;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(g3).toBeNull();
    expect(getBudgetStats().host.reservedMB).toBe(1000);

    g1.release();
    await g3p;
    g2.release();
    if (g3) (g3 as ResourceGrant).release();
  });

  it("enforces global concurrency cap", async () => {
    resetBudget();
    configureBudget({
      hostBudgetMB: 100_000,
      globalConcurrencyCap: 2,
      byAdapterType: {
        codex_local: { reservationMB: 100, capMB: 1024, budgetMB: 100_000 },
      },
      defaultType: { reservationMB: 100, capMB: 1024, budgetMB: 100_000 },
    });
    const g1 = await acquireResourceGrant({ runId: "r1", adapterType: "codex_local" });
    const g2 = await acquireResourceGrant({ runId: "r2", adapterType: "codex_local" });
    let g3: ResourceGrant | null = null;
    const p = acquireResourceGrant({ runId: "r3", adapterType: "codex_local" }).then(
      (g) => (g3 = g),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(g3).toBeNull();
    g1.release();
    await p;
    g2.release();
    if (g3) (g3 as ResourceGrant).release();
  });

  it("aborts waiter via AbortSignal without leaking reservation", async () => {
    const g1 = await acquireResourceGrant({ runId: "r1", adapterType: "claude_local" });
    const g2 = await acquireResourceGrant({ runId: "r2", adapterType: "claude_local" });

    const ctrl = new AbortController();
    const p = acquireResourceGrant(
      { runId: "r3", adapterType: "claude_local" },
      { signal: ctrl.signal },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(getBudgetStats().waiters).toBe(1);

    ctrl.abort();
    await expect(p).rejects.toThrow(/aborted/);

    expect(getBudgetStats().waiters).toBe(0);
    expect(getBudgetStats().host.reservedMB).toBe(2000);
    g1.release();
    g2.release();
    expect(getBudgetStats().host.reservedMB).toBe(0);
    expect(getBudgetStats().inFlight).toBe(0);
  });

  it("times out waiter without leaking reservation", async () => {
    const g1 = await acquireResourceGrant({ runId: "r1", adapterType: "claude_local" });
    const g2 = await acquireResourceGrant({ runId: "r2", adapterType: "claude_local" });

    const p = acquireResourceGrant(
      { runId: "r3", adapterType: "claude_local" },
      { timeoutMs: 30 },
    );
    await expect(p).rejects.toThrow(/timeout/);
    expect(getBudgetStats().waiters).toBe(0);
    g1.release();
    g2.release();
    expect(getBudgetStats().inFlight).toBe(0);
  });

  it("quarantine denies the affected type but not others", async () => {
    quarantineAdapterType("claude_local", 1000, "test");
    // Fresh claude cannot be admitted — queues.
    let cGrant: ResourceGrant | null = null;
    const cp = acquireResourceGrant({
      runId: "r1",
      adapterType: "claude_local",
    }).then((g) => (cGrant = g));
    await new Promise((r) => setTimeout(r, 10));
    expect(cGrant).toBeNull();

    // Codex still admits.
    const x = await acquireResourceGrant({
      runId: "r2",
      adapterType: "codex_local",
    });
    expect(x.adapterType).toBe("codex_local");
    x.release();

    // After quarantine expires (and backpressure called), claude admits.
    await new Promise((r) => setTimeout(r, 1100));
    applyBackPressure({ systemAvailableMB: 10_000, systemTotalMB: 16_000 });
    await cp;
    if (cGrant) (cGrant as ResourceGrant).release();
  });

  it("applyBackPressure emergency-stops on critical low memory", async () => {
    applyBackPressure({ systemAvailableMB: 100, systemTotalMB: 16_000 });
    expect(getBudgetStats().emergencyStoppedUntilMs).not.toBeNull();

    let g: ResourceGrant | null = null;
    const p = acquireResourceGrant({
      runId: "r1",
      adapterType: "claude_local",
    }).then((x) => (g = x));
    await new Promise((r) => setTimeout(r, 10));
    expect(g).toBeNull();

    applyBackPressure({ systemAvailableMB: 10_000, systemTotalMB: 16_000 });
    await p;
    expect(g).not.toBeNull();
    if (g) (g as ResourceGrant).release();
  });

  it("applyBackPressure oom delta triggers type quarantine", async () => {
    applyBackPressure({
      systemAvailableMB: 10_000,
      systemTotalMB: 16_000,
      oomKillsByAdapterType: { claude_local: 2 },
    });
    expect(getBudgetStats().quarantined.claude_local).toBeDefined();
    expect(getBudgetStats().quarantined.claude_local.reason).toContain("oom-kill");
  });

  it("observer fires admit/deny/release events", async () => {
    const events: string[] = [];
    const obs: BudgetObserver = {
      onAdmit: (g) => events.push(`admit:${g.runId}`),
      onDeny: (r, reason) => events.push(`deny:${r.runId}:${reason}`),
      onRelease: (g) => events.push(`release:${g.runId}`),
    };
    setBudgetObserver(obs);
    const g1 = await acquireResourceGrant({ runId: "r1", adapterType: "claude_local" });
    const g2 = await acquireResourceGrant({ runId: "r2", adapterType: "claude_local" });
    const ctrl = new AbortController();
    const p = acquireResourceGrant(
      { runId: "r3", adapterType: "claude_local" },
      { signal: ctrl.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(p).rejects.toThrow();
    g1.release();
    g2.release();

    expect(events).toContain("admit:r1");
    expect(events).toContain("admit:r2");
    expect(events).toContain("deny:r3:type-budget");
    expect(events).toContain("release:r1");
    expect(events).toContain("release:r2");
  });

  it("priority orders same-type waiters", async () => {
    const g1 = await acquireResourceGrant({ runId: "r1", adapterType: "claude_local" });
    const g2 = await acquireResourceGrant({ runId: "r2", adapterType: "claude_local" });

    const results: string[] = [];
    const pLow = acquireResourceGrant({
      runId: "low",
      adapterType: "claude_local",
      priority: 0,
    }).then((g) => {
      results.push("low");
      return g;
    });
    const pHigh = acquireResourceGrant({
      runId: "high",
      adapterType: "claude_local",
      priority: 10,
    }).then((g) => {
      results.push("high");
      return g;
    });

    g1.release(); // admits one waiter
    await Promise.race([pHigh, pLow]);
    expect(results[0]).toBe("high");

    g2.release();
    await Promise.all([pHigh, pLow]);
    (await pLow).release();
    (await pHigh).release();
  });

  it("recordPeakMB captures highest value", async () => {
    const g = await acquireResourceGrant({ runId: "r1", adapterType: "claude_local" });
    g.recordPeakMB(100);
    g.recordPeakMB(500);
    g.recordPeakMB(200);
    let releasedPeak: number | null = null;
    setBudgetObserver({
      onRelease: (_, peak) => {
        releasedPeak = peak;
      },
    });
    g.release();
    expect(releasedPeak).toBe(500);
  });
});
