import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  bigserial,
  boolean,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Append-only audit alert log per CISO §6.1 / §6.3.
 *
 * No UPDATE or DELETE should ever be issued against this table by
 * application code — immutability is enforced at the service layer.
 * Alert suppression is tracked via separate columns that require
 * CISO + board approval (CISO §6.3).
 */
export const auditAlerts = pgTable(
  "audit_alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),

    /** One of the 10 CISO §6.1 alert type IDs. */
    alertType: text("alert_type").notNull(),

    /** critical | high | medium | low */
    severity: text("severity").notNull(),

    /** Human-readable summary of what triggered the alert. */
    message: text("message").notNull(),

    /** Structured context: span IDs, run IDs, thresholds, etc. */
    details: jsonb("details").$type<Record<string, unknown>>(),

    /** Agent that triggered the alert condition (if applicable). */
    sourceAgentId: uuid("source_agent_id").references(() => agents.id),

    /** Run that triggered the alert condition (if applicable). */
    sourceRunId: uuid("source_run_id"),

    /** Response SLA from CISO §6.1 (e.g. "15 min", "1 hour", "4 hours"). */
    responseSla: text("response_sla"),

    /** Notification targets as a JSON array of role strings. */
    notifyTargets: jsonb("notify_targets").$type<string[]>(),

    /** Whether this alert has been acknowledged by an authorized actor. */
    acknowledged: boolean("acknowledged").notNull().default(false),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByAgentId: uuid("acknowledged_by_agent_id").references(() => agents.id),
    acknowledgedByUserId: text("acknowledged_by_user_id"),

    /**
     * Suppression requires CISO + board approval (CISO §6.3).
     * No agent can suppress its own alerts.
     */
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    suppressedByAgentId: uuid("suppressed_by_agent_id").references(() => agents.id),
    suppressedByUserId: text("suppressed_by_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("audit_alerts_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyTypeIdx: index("audit_alerts_company_type_idx").on(
      table.companyId,
      table.alertType,
    ),
    companySeverityIdx: index("audit_alerts_company_severity_idx").on(
      table.companyId,
      table.severity,
      table.createdAt,
    ),
    sourceAgentIdx: index("audit_alerts_source_agent_idx").on(
      table.sourceAgentId,
      table.createdAt,
    ),
  }),
);
