import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";

export const WARN_UTILIZATION_PERCENT = 80;
export const CRITICAL_UTILIZATION_PERCENT = 95;
export const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

type AlertLevel = "warning" | "critical";

const CRITICAL_ROLES = new Set(["ceo", "coo"]);
const alertDedup = new Map<string, number>();

const CREDIT_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /insufficient credit/i,
  /insufficient funds/i,
  /billing.*(required|details|issue)/i,
  /payment required/i,
  /\b402\b/,
  /quota exceeded/i,
  /usage limit exceeded/i,
  /resource[_\s-]?exhausted/i,
  /not logged in/i,
  /token expired/i,
  /invalid api key/i,
  /authentication failed/i,
];

function providerFromAdapterType(adapterType: string): string {
  switch (adapterType) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    case "gemini_local":
      return "google";
    default:
      return adapterType;
  }
}

function adapterTypesForProvider(provider: string): string[] {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return ["claude_local"];
    case "openai":
      return ["codex_local"];
    case "google":
    case "gemini":
      return ["gemini_local"];
    default:
      return [provider];
  }
}

function dedupKey(companyId: string, provider: string, level: AlertLevel): string {
  return `${companyId}:${provider.toLowerCase()}:${level}`;
}

function shouldEmitAlert(companyId: string, provider: string, level: AlertLevel): boolean {
  const now = Date.now();
  const key = dedupKey(companyId, provider, level);
  const lastSentAt = alertDedup.get(key);
  if (lastSentAt && now - lastSentAt < ALERT_DEDUP_WINDOW_MS) {
    return false;
  }
  alertDedup.set(key, now);
  return true;
}

function computePeakUtilization(windows: QuotaWindow[]): number | null {
  let peak: number | null = null;
  for (const window of windows) {
    if (typeof window.usedPercent !== "number" || Number.isNaN(window.usedPercent)) continue;
    peak = peak == null ? window.usedPercent : Math.max(peak, window.usedPercent);
  }
  return peak;
}

function classifyLevel(peakPercent: number): AlertLevel | null {
  if (peakPercent >= CRITICAL_UTILIZATION_PERCENT) return "critical";
  if (peakPercent >= WARN_UTILIZATION_PERCENT) return "warning";
  return null;
}

function buildWindowSummary(windows: QuotaWindow[]): string {
  const relevant = windows.filter((window) => {
    return typeof window.usedPercent === "number" && window.usedPercent >= WARN_UTILIZATION_PERCENT;
  });
  if (relevant.length === 0) return "- No quota windows at or above warning threshold.";

  return relevant
    .slice(0, 8)
    .map((window) => {
      const pct = window.usedPercent == null ? "n/a" : `${window.usedPercent.toFixed(1)}%`;
      const reset = window.resetsAt ? `, resets ${window.resetsAt}` : "";
      const detail = window.detail ? ` (${window.detail})` : "";
      const value = window.valueLabel ? `, ${window.valueLabel}` : "";
      return `- ${window.label}: ${pct}${value}${reset}${detail}`;
    })
    .join("\n");
}

function buildAlertTitle(provider: string, level: AlertLevel, peakPercent?: number | null): string {
  const providerLabel = provider.toUpperCase();
  if (level === "critical") {
    return peakPercent != null
      ? `[CRITICAL] ${providerLabel} quota at ${Math.round(peakPercent)}%`
      : `[CRITICAL] ${providerLabel} credit/quota failure detected`;
  }
  return `[WARNING] ${providerLabel} quota at ${Math.round(peakPercent ?? WARN_UTILIZATION_PERCENT)}%`;
}

async function resolveAlertAssigneeAgentId(db: Db, companyId: string): Promise<string | null> {
  const ceo = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), ne(agents.status, "terminated")))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
  if (ceo) return ceo;

  return db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "coo"), ne(agents.status, "terminated")))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

export async function pauseNonCriticalAgents(
  db: Db,
  companyId: string,
  provider: string,
): Promise<{ pausedCount: number; pausedAgentIds: string[] }> {
  const adapterTypes = adapterTypesForProvider(provider);
  if (adapterTypes.length === 0) return { pausedCount: 0, pausedAgentIds: [] };

  const candidates = await db
    .select({
      id: agents.id,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.adapterType, adapterTypes)));

  const pausableAgentIds = candidates
    .filter((agent) => !CRITICAL_ROLES.has(agent.role.toLowerCase()))
    .filter((agent) => !["paused", "terminated", "pending_approval"].includes(agent.status))
    .map((agent) => agent.id);

  if (pausableAgentIds.length === 0) return { pausedCount: 0, pausedAgentIds: [] };

  await db
    .update(agents)
    .set({
      status: "paused",
      pauseReason: "system",
      pausedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, pausableAgentIds)));

  return { pausedCount: pausableAgentIds.length, pausedAgentIds: pausableAgentIds };
}

export async function createQuotaAlertIssue(
  db: Db,
  opts: {
    companyId: string;
    provider: string;
    level: AlertLevel;
    peakPercent?: number | null;
    windows?: QuotaWindow[];
    errorMessage?: string;
    pausedCount?: number;
    triggerAgentId?: string | null;
  },
): Promise<string | null> {
  if (!shouldEmitAlert(opts.companyId, opts.provider, opts.level)) {
    return null;
  }

  const issuesSvc = issueService(db);
  const assigneeAgentId = await resolveAlertAssigneeAgentId(db, opts.companyId);
  const title = buildAlertTitle(opts.provider, opts.level, opts.peakPercent);
  const lines = [
    "## Quota Health Alert",
    "",
    `- Provider: \`${opts.provider}\``,
    `- Severity: \`${opts.level}\``,
    ...(opts.peakPercent != null ? [`- Peak utilization: \`${opts.peakPercent.toFixed(1)}%\``] : []),
    ...(typeof opts.pausedCount === "number" ? [`- Agents auto-paused: \`${opts.pausedCount}\``] : []),
    "",
  ];

  if (opts.errorMessage) {
    lines.push("### Trigger", "", "Detected credit/auth/quota failure in heartbeat run:", "", "```text");
    lines.push(opts.errorMessage.trim());
    lines.push("```", "");
  }

  if (opts.windows && opts.windows.length > 0) {
    lines.push("### Quota windows", "", buildWindowSummary(opts.windows), "");
  }

  const created = await issuesSvc.create(opts.companyId, {
    title,
    description: lines.join("\n").trim(),
    status: "todo",
    priority: opts.level === "critical" ? "critical" : "high",
    assigneeAgentId: assigneeAgentId ?? undefined,
    createdByAgentId: opts.triggerAgentId ?? null,
  });
  return created.id;
}

export function isLikelyCreditError(errorMessage: string): boolean {
  const text = errorMessage.trim();
  if (!text) return false;
  return CREDIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function quotaHealthService(db: Db) {
  async function checkAfterRun(companyId: string): Promise<void> {
    const results = await fetchAllQuotaWindows();
    for (const result of results) {
      if (!result.ok) continue;
      const peakPercent = computePeakUtilization(result.windows);
      if (peakPercent == null) continue;
      const level = classifyLevel(peakPercent);
      if (!level) continue;

      if (level === "critical") {
        const pauseResult = await pauseNonCriticalAgents(db, companyId, result.provider);
        await createQuotaAlertIssue(db, {
          companyId,
          provider: result.provider,
          level,
          peakPercent,
          windows: result.windows,
          pausedCount: pauseResult.pausedCount,
        });
        continue;
      }

      await createQuotaAlertIssue(db, {
        companyId,
        provider: result.provider,
        level,
        peakPercent,
        windows: result.windows,
      });
    }
  }

  async function handleCreditError(companyId: string, agentId: string, errorMessage: string): Promise<void> {
    if (!isLikelyCreditError(errorMessage)) return;

    const agent = await db
      .select({
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const provider = agent?.adapterType ? providerFromAdapterType(agent.adapterType) : "unknown";
    const pauseResult = await pauseNonCriticalAgents(db, companyId, provider);

    await createQuotaAlertIssue(db, {
      companyId,
      provider,
      level: "critical",
      errorMessage,
      pausedCount: pauseResult.pausedCount,
      triggerAgentId: agentId,
    });
  }

  return {
    checkAfterRun: async (companyId: string) => {
      try {
        await checkAfterRun(companyId);
      } catch (error) {
        logger.warn({ err: error, companyId }, "quota health check failed");
      }
    },
    handleCreditError: async (companyId: string, agentId: string, errorMessage: string) => {
      try {
        await handleCreditError(companyId, agentId, errorMessage);
      } catch (error) {
        logger.warn({ err: error, companyId, agentId }, "quota credit-error handling failed");
      }
    },
  };
}

export function classifyQuotaResult(result: ProviderQuotaResult): {
  provider: string;
  peakPercent: number | null;
  level: AlertLevel | null;
} {
  const peakPercent = result.ok ? computePeakUtilization(result.windows) : null;
  return {
    provider: result.provider,
    peakPercent,
    level: peakPercent == null ? null : classifyLevel(peakPercent),
  };
}
