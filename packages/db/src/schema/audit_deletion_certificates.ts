import { pgTable, uuid, text, timestamp, bigint, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Deletion certificates per CLO §3.
 * Every batch deletion of audit spans produces a signed certificate
 * proving what was deleted, when, and why. Append-only — no UPDATE/DELETE.
 */
export const auditDeletionCertificates = pgTable(
  "audit_deletion_certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),

    /** Reason for deletion: "lifecycle_expiry" | "manual_purge" | "gdpr_request" */
    reason: text("reason").notNull(),
    /** Hash of all deleted span IDs (SHA-256) for verifiability */
    deletedSpansHash: text("deleted_spans_hash").notNull(),
    /** Number of spans deleted in this batch */
    deletedSpanCount: bigint("deleted_span_count", { mode: "number" }).notNull(),
    /** Earliest span start_time in the deleted batch */
    timeRangeStart: timestamp("time_range_start", { withTimezone: true }).notNull(),
    /** Latest span start_time in the deleted batch */
    timeRangeEnd: timestamp("time_range_end", { withTimezone: true }).notNull(),
    /** Storage tier the spans were in at deletion time */
    storageTier: text("storage_tier").notNull(),
    /** Ed25519 signature over certificate fields */
    signature: text("signature"),
    /** Who initiated the deletion: "system:lifecycle" | agent/user id */
    deletedBy: text("deleted_by").notNull().default("system:lifecycle"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("audit_deletion_certs_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
