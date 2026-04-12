import { pgTable, uuid, text, timestamp, integer, bigint, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

/**
 * Audit export jobs per CISO §3.2.
 *
 * Tracks export requests through the approval gate and processing pipeline.
 * Exports >10,000 spans require CISO/board approval (async gate).
 * Each export includes Merkle inclusion proofs and AES-256-GCM encrypted output.
 * Export events are themselves audited.
 *
 * Status flow: pending_count → pending_approval → approved → processing → completed | failed | rejected
 * (Exports ≤10k skip pending_approval and go directly to processing)
 */
export const auditExportJobs = pgTable(
  "audit_export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),

    // ── Requestor ────────────────────────────────────────────────
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),

    // ── Status ───────────────────────────────────────────────────
    /** pending_count | pending_approval | approved | processing | completed | failed | rejected */
    status: text("status").notNull().default("pending_count"),

    // ── Filters & scope ──────────────────────────────────────────
    /** Query filters used to select spans for export */
    filters: jsonb("filters").$type<{
      agentId?: string;
      issueId?: string;
      runId?: string;
      actionType?: string;
      outcome?: string;
      startTime?: string;
      endTime?: string;
    }>().notNull(),

    // ── Span count & approval gate ───────────────────────────────
    /** Actual span count matching the filters */
    spanCount: integer("span_count"),
    /** Linked approval ID when >10k spans require CISO/board approval */
    approvalId: uuid("approval_id").references(() => approvals.id),

    // ── Output encryption ────────────────────────────────────────
    /** Per-export AES-256-GCM encrypted output (base64) */
    encryptedOutput: text("encrypted_output"),
    /** Encryption scheme for the output */
    outputEncryptionScheme: text("output_encryption_scheme"),
    /** Per-export key version */
    outputEncryptionKeyVersion: integer("output_encryption_key_version"),
    /** 12-byte IV for output encryption (base64) */
    outputEncryptionIv: text("output_encryption_iv"),
    /** GCM auth tag for output encryption (base64) */
    outputEncryptionTag: text("output_encryption_tag"),

    // ── Merkle inclusion proofs ──────────────────────────────────
    /** Array of Merkle inclusion proofs keyed by span ID */
    merkleProofs: jsonb("merkle_proofs").$type<Array<{
      spanId: string;
      leafHash: string;
      rootId: string;
      rootHash: string;
      siblingPath: string[];
      pathDirections: Array<"left" | "right">;
    }>>(),

    // ── Output metadata ──────────────────────────────────────────
    /** Size of the encrypted output in bytes */
    outputSizeBytes: bigint("output_size_bytes", { mode: "number" }),
    /** Error message if export failed */
    error: text("error"),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("audit_export_jobs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyCreatedIdx: index("audit_export_jobs_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    approvalIdx: index("audit_export_jobs_approval_idx").on(table.approvalId),
  }),
);
