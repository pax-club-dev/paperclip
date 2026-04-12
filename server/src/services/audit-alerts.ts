/**
 * Audit alert engine — implements all 10 CISO §6.1 alert types with
 * severity-based routing and an append-only alert log.
 *
 * Alerts are immutable once written: the only mutations allowed are
 * acknowledgment (any authorized actor) and suppression (CISO + board
 * approval required per §6.3).
 *
 * Alert delivery targets are recorded but out-of-band delivery
 * (PagerDuty/Opsgenie/Signal) is handled by a separate notification
 * adapter — this service writes the alert record and publishes a
 * live event that the adapter consumes.
 */

import { eq, and, desc, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditAlerts } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";
import { logger } from "../middleware/logger.js";

// ── Alert type definitions per CISO §6.1 ────────────────────────

export type AlertType =
  | "TAMPER_DETECTED"
  | "TRACE_AUTH_FAILURE"
  | "SEQUENCE_GAP"
  | "EXCESSIVE_QUERY"
  | "EXPORT_ANOMALY"
  | "COLLECTOR_DOWN"
  | "CLOCK_SKEW"
  | "AGENT_TRACE_VOLUME_ANOMALY"
  | "CROSS_TENANT_ATTEMPT"
  | "KEY_ROTATION_OVERDUE";

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export interface AlertDefinition {
  alertType: AlertType;
  severity: AlertSeverity;
  responseSla: string;
  notifyTargets: string[];
}

/**
 * Full CISO §6.1 alert table — static definitions.
 */
export const ALERT_DEFINITIONS: Record<AlertType, AlertDefinition> = {
  TAMPER_DETECTED: {
    alertType: "TAMPER_DETECTED",
    severity: "critical",
    responseSla: "15 min",
    notifyTargets: ["ciso", "clo", "board"],
  },
  TRACE_AUTH_FAILURE: {
    alertType: "TRACE_AUTH_FAILURE",
    severity: "critical",
    responseSla: "15 min",
    notifyTargets: ["ciso"],
  },
  SEQUENCE_GAP: {
    alertType: "SEQUENCE_GAP",
    severity: "high",
    responseSla: "1 hour",
    notifyTargets: ["ciso"],
  },
  EXCESSIVE_QUERY: {
    alertType: "EXCESSIVE_QUERY",
    severity: "medium",
    responseSla: "4 hours",
    notifyTargets: ["ciso"],
  },
  EXPORT_ANOMALY: {
    alertType: "EXPORT_ANOMALY",
    severity: "high",
    responseSla: "1 hour",
    notifyTargets: ["ciso", "board"],
  },
  COLLECTOR_DOWN: {
    alertType: "COLLECTOR_DOWN",
    severity: "critical",
    responseSla: "15 min",
    notifyTargets: ["ciso", "cto"],
  },
  CLOCK_SKEW: {
    alertType: "CLOCK_SKEW",
    severity: "low",
    responseSla: "24 hours",
    notifyTargets: ["cto"],
  },
  AGENT_TRACE_VOLUME_ANOMALY: {
    alertType: "AGENT_TRACE_VOLUME_ANOMALY",
    severity: "medium",
    responseSla: "4 hours",
    notifyTargets: ["ciso"],
  },
  CROSS_TENANT_ATTEMPT: {
    alertType: "CROSS_TENANT_ATTEMPT",
    severity: "critical",
    responseSla: "15 min",
    notifyTargets: ["ciso", "board"],
  },
  KEY_ROTATION_OVERDUE: {
    alertType: "KEY_ROTATION_OVERDUE",
    severity: "high",
    responseSla: "24 hours",
    notifyTargets: ["ciso"],
  },
};

// ── Input types ─────────────────────────────────────────────────

export interface RaiseAlertInput {
  companyId: string;
  alertType: AlertType;
  message: string;
  details?: Record<string, unknown>;
  sourceAgentId?: string | null;
  sourceRunId?: string | null;
}

export interface AlertFilters {
  companyId: string;
  alertType?: AlertType;
  severity?: AlertSeverity;
  acknowledged?: boolean;
  since?: Date;
  limit?: number;
}

// ── Service ─────────────────────────────────────────────────────

export function auditAlertService(db: Db) {
  return {
    /**
     * Raise an alert — appends to the immutable alert log,
     * publishes a live event for out-of-band delivery, and
     * logs to the activity trail.
     */
    async raise(input: RaiseAlertInput) {
      const def = ALERT_DEFINITIONS[input.alertType];
      if (!def) {
        throw new Error(`Unknown alert type: ${input.alertType}`);
      }

      const logLevel = def.severity === "critical" ? "fatal" : def.severity === "high" ? "error" : "warn";
      logger[logLevel](
        {
          companyId: input.companyId,
          alertType: input.alertType,
          severity: def.severity,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceRunId: input.sourceRunId ?? null,
        },
        `AUDIT ALERT [${def.severity.toUpperCase()}]: ${input.alertType} — ${input.message}`,
      );

      const [alert] = await db
        .insert(auditAlerts)
        .values({
          companyId: input.companyId,
          alertType: input.alertType,
          severity: def.severity,
          message: input.message,
          details: input.details ?? null,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceRunId: input.sourceRunId ?? null,
          responseSla: def.responseSla,
          notifyTargets: def.notifyTargets,
        })
        .returning();

      // Activity log entry for audit trail of the alert itself.
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "audit-alert-engine",
        action: `audit.alert.${input.alertType.toLowerCase()}`,
        entityType: "audit_alert",
        entityId: String(alert.id),
        details: {
          alertType: input.alertType,
          severity: def.severity,
          responseSla: def.responseSla,
          notifyTargets: def.notifyTargets,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceRunId: input.sourceRunId ?? null,
          ...input.details,
        },
      });

      // Publish live event for out-of-band notification adapter
      // (PagerDuty/Opsgenie/Signal per CISO §6.3).
      publishLiveEvent({
        companyId: input.companyId,
        type: "audit.alert.raised",
        payload: {
          alertId: alert.id,
          alertType: input.alertType,
          severity: def.severity,
          message: input.message,
          responseSla: def.responseSla,
          notifyTargets: def.notifyTargets,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceRunId: input.sourceRunId ?? null,
          details: input.details ?? null,
        },
      });

      return alert;
    },

    /**
     * List alerts with optional filters.
     */
    async list(filters: AlertFilters) {
      const conditions = [eq(auditAlerts.companyId, filters.companyId)];

      if (filters.alertType) {
        conditions.push(eq(auditAlerts.alertType, filters.alertType));
      }
      if (filters.severity) {
        conditions.push(eq(auditAlerts.severity, filters.severity));
      }
      if (filters.acknowledged !== undefined) {
        conditions.push(eq(auditAlerts.acknowledged, filters.acknowledged));
      }
      if (filters.since) {
        conditions.push(gte(auditAlerts.createdAt, filters.since));
      }

      const limit = Math.min(filters.limit ?? 100, 500);

      return db
        .select()
        .from(auditAlerts)
        .where(and(...conditions))
        .orderBy(desc(auditAlerts.createdAt))
        .limit(limit);
    },

    /**
     * Get a single alert by ID.
     */
    async getById(id: number) {
      const [alert] = await db
        .select()
        .from(auditAlerts)
        .where(eq(auditAlerts.id, id));
      return alert ?? null;
    },

    /**
     * Acknowledge an alert. Acknowledgment is the only mutable
     * operation allowed without CISO approval.
     */
    async acknowledge(
      alertId: number,
      actorInfo: { agentId?: string | null; userId?: string | null },
    ) {
      const [updated] = await db
        .update(auditAlerts)
        .set({
          acknowledged: true,
          acknowledgedAt: new Date(),
          acknowledgedByAgentId: actorInfo.agentId ?? null,
          acknowledgedByUserId: actorInfo.userId ?? null,
        })
        .where(eq(auditAlerts.id, alertId))
        .returning();
      return updated ?? null;
    },

    /**
     * Count unacknowledged alerts by severity for a company.
     * Useful for dashboard/sidebar badges.
     */
    async countUnacknowledged(companyId: string) {
      const rows = await db
        .select({
          severity: auditAlerts.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(auditAlerts)
        .where(
          and(
            eq(auditAlerts.companyId, companyId),
            eq(auditAlerts.acknowledged, false),
          ),
        )
        .groupBy(auditAlerts.severity);

      const counts: Record<string, number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      for (const row of rows) {
        counts[row.severity] = row.count;
      }
      return counts;
    },

    // ── Convenience raisers for each alert type ─────────────────

    /** CISO §2.2: Merkle root mismatch on any batch. */
    async raiseTamperDetected(
      companyId: string,
      details: Record<string, unknown>,
    ) {
      return this.raise({
        companyId,
        alertType: "TAMPER_DETECTED",
        message: "Merkle root integrity verification failed — possible trace tampering",
        details,
      });
    },

    /** CISO §2.1: Span signature verification fails. */
    async raiseTraceAuthFailure(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string; sourceRunId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "TRACE_AUTH_FAILURE",
        message: "Span signature verification failed — unsigned or forged span detected",
        details,
        sourceAgentId: details.sourceAgentId,
        sourceRunId: details.sourceRunId,
      });
    },

    /** CISO §2.3: Missing sequence numbers in agent run. */
    async raiseSequenceGap(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string; sourceRunId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "SEQUENCE_GAP",
        message: "Missing sequence numbers detected in agent trace stream",
        details,
        sourceAgentId: details.sourceAgentId,
        sourceRunId: details.sourceRunId,
      });
    },

    /** CISO §3.1: Query rate exceeds threshold. */
    async raiseExcessiveQuery(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "EXCESSIVE_QUERY",
        message: "Trace query rate exceeded threshold",
        details,
        sourceAgentId: details.sourceAgentId,
      });
    },

    /** CISO §3.2: Export >1000 spans by non-board user. */
    async raiseExportAnomaly(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "EXPORT_ANOMALY",
        message: "Large trace export by non-board user",
        details,
        sourceAgentId: details.sourceAgentId,
      });
    },

    /** Collector health check fails for >60s. */
    async raiseCollectorDown(companyId: string, details: Record<string, unknown>) {
      return this.raise({
        companyId,
        alertType: "COLLECTOR_DOWN",
        message: "OTel collector health check failed for >60 seconds",
        details,
      });
    },

    /** Span timestamp >5s from collector time. */
    async raiseClockSkew(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string; sourceRunId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "CLOCK_SKEW",
        message: "Span timestamp exceeds 5-second clock skew tolerance",
        details,
        sourceAgentId: details.sourceAgentId,
        sourceRunId: details.sourceRunId,
      });
    },

    /** Agent produces >3σ above baseline spans/hour. */
    async raiseTraceVolumeAnomaly(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "AGENT_TRACE_VOLUME_ANOMALY",
        message: "Agent trace volume exceeds 3 standard deviations above baseline",
        details,
        sourceAgentId: details.sourceAgentId,
      });
    },

    /** Query includes company ID not matching auth. */
    async raiseCrossTenantAttempt(
      companyId: string,
      details: Record<string, unknown> & { sourceAgentId?: string },
    ) {
      return this.raise({
        companyId,
        alertType: "CROSS_TENANT_ATTEMPT",
        message: "Cross-tenant trace access attempt detected",
        details,
        sourceAgentId: details.sourceAgentId,
      });
    },

    /** CMEK rotation >90 days without rotation event. */
    async raiseKeyRotationOverdue(companyId: string, details: Record<string, unknown>) {
      return this.raise({
        companyId,
        alertType: "KEY_ROTATION_OVERDUE",
        message: "Encryption key rotation overdue (>90 days)",
        details,
      });
    },
  };
}
