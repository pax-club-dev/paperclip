// Wires resource-budget configuration and pino-based observer at server startup.
//
// Consumes two env vars:
//   - PAPERCLIP_HOST_BUDGET_MB        scalar override (MB)
//   - PAPERCLIP_ADAPTER_BUDGET_JSON   structured per-type override. Shape:
//       { "claude_local": {"reservationMB":1536,"capMB":4096,"budgetMB":9216},
//         "codex_local":  {"reservationMB":768,"capMB":3072,"budgetMB":3072},
//         "__default":    {"reservationMB":512,"capMB":2048,"budgetMB":2048} }
//
// Invalid JSON fails startup with a descriptive error. Missing fields fall
// back to the per-type defaults baked into resource-budget.

import {
  configureBudget,
  getBudgetConfig,
  setBudgetObserver,
  type AdapterTypeBudget,
  type BudgetConfig,
  type ResourceGrant,
  type ResourceReservation,
} from "@paperclipai/adapter-utils/resource-budget";
import { logger } from "../middleware/logger.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function isObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseAdapterTypeBudget(raw: JsonValue, key: string): AdapterTypeBudget {
  if (!isObject(raw)) {
    throw new Error(
      `PAPERCLIP_ADAPTER_BUDGET_JSON: entry "${key}" must be an object`,
    );
  }
  const requireNumber = (field: string): number => {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(
        `PAPERCLIP_ADAPTER_BUDGET_JSON: "${key}.${field}" must be a positive number, got ${JSON.stringify(v)}`,
      );
    }
    return v;
  };
  return {
    reservationMB: requireNumber("reservationMB"),
    capMB: requireNumber("capMB"),
    budgetMB: requireNumber("budgetMB"),
  };
}

function parseBudgetJson(raw: string): Partial<BudgetConfig> {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`PAPERCLIP_ADAPTER_BUDGET_JSON is not valid JSON: ${msg}`);
  }
  if (!isObject(parsed)) {
    throw new Error(
      `PAPERCLIP_ADAPTER_BUDGET_JSON must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  const byAdapterType: Record<string, AdapterTypeBudget> = {};
  let defaultType: AdapterTypeBudget | undefined;
  for (const [key, value] of Object.entries(parsed)) {
    const parsedEntry = parseAdapterTypeBudget(value as JsonValue, key);
    if (key === "__default") defaultType = parsedEntry;
    else byAdapterType[key] = parsedEntry;
  }
  const out: Partial<BudgetConfig> = { byAdapterType };
  if (defaultType) out.defaultType = defaultType;
  return out;
}

export function bootstrapResourceBudget(): void {
  const partial: Partial<BudgetConfig> = {};
  const hostEnv = process.env.PAPERCLIP_HOST_BUDGET_MB;
  if (hostEnv) {
    const n = Number(hostEnv);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `PAPERCLIP_HOST_BUDGET_MB must be a positive number, got ${JSON.stringify(hostEnv)}`,
      );
    }
    partial.hostBudgetMB = Math.round(n);
  }
  const budgetJson = process.env.PAPERCLIP_ADAPTER_BUDGET_JSON;
  if (budgetJson && budgetJson.trim()) {
    Object.assign(partial, parseBudgetJson(budgetJson));
  }
  if (Object.keys(partial).length > 0) {
    configureBudget(partial);
  }

  setBudgetObserver({
    onAdmit(grant: ResourceGrant) {
      logger.debug(
        {
          runId: grant.runId,
          adapterType: grant.adapterType,
          scopeUnit: grant.scopeUnit,
          reservationMB: grant.reservationMB,
          capMB: grant.capMB,
        },
        "resource-budget: admit",
      );
    },
    onDeny(reservation: ResourceReservation, reason: string) {
      logger.info(
        {
          runId: reservation.runId,
          adapterType: reservation.adapterType,
          reason,
        },
        "resource-budget: deny (queued)",
      );
    },
    onRelease(grant: ResourceGrant, peakMB: number | null) {
      logger.debug(
        {
          runId: grant.runId,
          adapterType: grant.adapterType,
          heldMs: Date.now() - grant.grantedAt.getTime(),
          observedPeakMB: peakMB,
          reservationMB: grant.reservationMB,
        },
        "resource-budget: release",
      );
    },
    onQuarantine(adapterType: string, untilMs: number, reason: string) {
      logger.warn(
        { adapterType, untilMs, reason },
        "resource-budget: adapter type quarantined",
      );
    },
    onBackPressure(_prev: boolean, next: boolean, reason: string | null) {
      if (next) {
        logger.error({ reason }, "resource-budget: emergency-stop activated");
      } else {
        logger.warn("resource-budget: emergency-stop cleared");
      }
    },
  });

  const effective = getBudgetConfig();
  logger.info(
    {
      hostBudgetMB: effective.hostBudgetMB,
      globalConcurrencyCap: effective.globalConcurrencyCap,
      adapterTypes: Object.keys(effective.byAdapterType),
      defaultType: effective.defaultType,
    },
    "resource-budget: bootstrapped",
  );
}
