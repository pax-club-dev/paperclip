import { pgTable, uuid, text, timestamp, bigint, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Primary trace storage table for the OpenTelemetry audit trail.
 * Contains all CLO §2 required fields plus encryption and tier metadata.
 *
 * Storage tiers:
 *   hot   — queryable, first 30 days
 *   cold  — compressed/archived, days 31–90
 *   (deleted after 90 days unless legal_hold is set)
 */
export const auditSpans = pgTable(
  "audit_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // ── CLO §2 required trace fields ────────────────────────────
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    issueId: uuid("issue_id"),

    // Action metadata
    actionType: text("action_type").notNull(),
    outcome: text("outcome").notNull(),
    targetResource: text("target_resource"),

    // Timing
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),

    // ── Integrity fields ────────────────────────────────────────
    /** Ed25519 signature over canonical span fields (Phase 2) */
    signature: text("signature"),
    /** Monotonic per agent+run for gap detection (CISO §2.3) */
    sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull(),

    // ── Encryption fields ───────────────────────────────────────
    /** AES-256-GCM encrypted payload containing full span attributes */
    encryptedPayload: text("encrypted_payload").notNull(),
    /** Encryption scheme identifier for key rotation */
    encryptionScheme: text("encryption_scheme").notNull().default("aes-256-gcm-local-v1"),
    /** Key version used for encryption (supports rotation) */
    encryptionKeyVersion: integer("encryption_key_version").notNull().default(1),
    /** 12-byte IV, base64-encoded */
    encryptionIv: text("encryption_iv").notNull(),
    /** GCM auth tag, base64-encoded */
    encryptionTag: text("encryption_tag").notNull(),

    // ── Tier management ─────────────────────────────────────────
    storageTier: text("storage_tier").notNull().default("hot"),
    /** Legal hold prevents deletion regardless of tier lifecycle */
    legalHold: boolean("legal_hold").notNull().default(false),
    /** Reason for legal hold (if any) */
    legalHoldReason: text("legal_hold_reason"),
    /** Override retention in days (e.g. 1095 for FAA 3-year) */
    retentionOverrideDays: integer("retention_override_days"),
    /** When this span was migrated to cold tier */
    coldMigratedAt: timestamp("cold_migrated_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary query indexes per plan §4.1
    companyAgentTimeIdx: index("audit_spans_company_agent_time_idx").on(
      table.companyId,
      table.agentId,
      table.startTime,
    ),
    companyIssueTimeIdx: index("audit_spans_company_issue_time_idx").on(
      table.companyId,
      table.issueId,
      table.startTime,
    ),
    companyRunIdx: index("audit_spans_company_run_idx").on(
      table.companyId,
      table.runId,
    ),
    // Tier lifecycle queries
    storageTierTimeIdx: index("audit_spans_tier_time_idx").on(
      table.storageTier,
      table.startTime,
    ),
    // Sequence gap detection per agent+run
    agentRunSeqIdx: index("audit_spans_agent_run_seq_idx").on(
      table.agentId,
      table.runId,
      table.sequenceNumber,
    ),
    // Trace correlation
    traceIdIdx: index("audit_spans_trace_id_idx").on(table.traceId),
  }),
);
