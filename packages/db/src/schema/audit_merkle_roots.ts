import { pgTable, uuid, text, timestamp, integer, index, bigint } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Append-only ledger of Merkle tree roots computed over audit span batches.
 * Supports tamper detection per CISO §2.2 — no UPDATE or DELETE should ever
 * be granted to the application database user on this table.
 */
export const auditMerkleRoots = pgTable(
  "audit_merkle_roots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rootHash: text("root_hash").notNull(),
    previousRootHash: text("previous_root_hash"),
    batchStartTime: timestamp("batch_start_time", { withTimezone: true }).notNull(),
    batchEndTime: timestamp("batch_end_time", { withTimezone: true }).notNull(),
    spanCount: integer("span_count").notNull(),
    leafHashes: text("leaf_hashes").array().notNull(),
    sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySeqIdx: index("audit_merkle_roots_company_seq_idx").on(
      table.companyId,
      table.sequenceNumber,
    ),
    companyTimeIdx: index("audit_merkle_roots_company_time_idx").on(
      table.companyId,
      table.batchStartTime,
    ),
    rootHashIdx: index("audit_merkle_roots_root_hash_idx").on(table.rootHash),
  }),
);
