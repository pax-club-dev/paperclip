/**
 * Audit span storage tier lifecycle.
 *
 * Tier rules (CLO §3, CISO §4.2):
 *   hot  (0–30 days)  — primary table, fully queryable
 *   cold (31–90 days) — compressed payload, limited queries
 *   deleted (>90 days) — removed with deletion certificate
 *
 * Legal holds and retention overrides (e.g. FAA 3-year) are respected.
 */
import { and, eq, lt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditSpans, auditDeletionCertificates } from "@paperclipai/db";
import { hashSpanIds } from "./audit-encryption.js";
import { logger } from "../middleware/logger.js";

// ── Configuration ───────────────────────────────────────────────

/** Days in hot tier before migrating to cold. */
const HOT_RETENTION_DAYS = 30;

/** Days in cold tier before deletion (total age = HOT + COLD = 90). */
const COLD_RETENTION_DAYS = 90;

/** Maximum rows to process per batch to keep transactions bounded. */
const BATCH_SIZE = 2_000;

/** Maximum iterations per sweep to prevent unbounded loops. */
const MAX_ITERATIONS = 200;

// ── Hot → Cold Migration ────────────────────────────────────────

export interface MigrationResult {
  migratedCount: number;
}

/**
 * Migrate hot-tier spans older than `hotRetentionDays` to cold tier.
 *
 * Cold migration updates the storage_tier and records the migration timestamp.
 * Legal-held spans are skipped.
 */
export async function migrateHotToCold(
  db: Db,
  hotRetentionDays: number = HOT_RETENTION_DAYS,
): Promise<MigrationResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - hotRetentionDays);

  let totalMigrated = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const migrated = await db
      .update(auditSpans)
      .set({
        storageTier: "cold",
        coldMigratedAt: new Date(),
      })
      .where(
        and(
          eq(auditSpans.storageTier, "hot"),
          lt(auditSpans.startTime, cutoff),
          eq(auditSpans.legalHold, false),
          isNull(auditSpans.retentionOverrideDays),
        ),
      )
      .returning({ id: auditSpans.id })
      .then((rows) => rows.length);

    totalMigrated += migrated;
    iterations++;

    if (migrated < BATCH_SIZE) break;
  }

  // Handle spans with retention overrides separately —
  // they should only migrate to cold if still within their extended retention window.
  const overrideMigrated = await db
    .update(auditSpans)
    .set({
      storageTier: "cold",
      coldMigratedAt: new Date(),
    })
    .where(
      and(
        eq(auditSpans.storageTier, "hot"),
        eq(auditSpans.legalHold, false),
        // Only migrate if past the hot window but within retention override
        lt(auditSpans.startTime, cutoff),
        sql`${auditSpans.startTime} > NOW() - (${auditSpans.retentionOverrideDays} || ' days')::interval`,
      ),
    )
    .returning({ id: auditSpans.id })
    .then((rows) => rows.length);

  totalMigrated += overrideMigrated;

  if (totalMigrated > 0) {
    logger.info({ totalMigrated, hotRetentionDays }, "Migrated audit spans from hot to cold tier");
  }

  return { migratedCount: totalMigrated };
}

// ── Cold → Delete (with Deletion Certificates) ─────────────────

export interface DeletionResult {
  deletedCount: number;
  certificateId: string | null;
}

/**
 * Delete cold-tier spans older than `coldRetentionDays` and produce
 * a deletion certificate per CLO §3.
 *
 * Skips legal-held spans and spans with active retention overrides.
 */
export async function deleteColdSpans(
  db: Db,
  coldRetentionDays: number = COLD_RETENTION_DAYS,
): Promise<DeletionResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - coldRetentionDays);

  // Collect IDs for the deletion certificate before deleting.
  // Process in batches to avoid unbounded memory.
  const allDeletedIds: string[] = [];
  let timeRangeStart: Date | null = null;
  let timeRangeEnd: Date | null = null;
  let companyId: string | null = null;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const batch = await db
      .select({
        id: auditSpans.id,
        companyId: auditSpans.companyId,
        startTime: auditSpans.startTime,
      })
      .from(auditSpans)
      .where(
        and(
          eq(auditSpans.storageTier, "cold"),
          lt(auditSpans.startTime, cutoff),
          eq(auditSpans.legalHold, false),
          // Exclude spans with unexpired retention overrides
          sql`(${auditSpans.retentionOverrideDays} IS NULL OR ${auditSpans.startTime} < NOW() - (${auditSpans.retentionOverrideDays} || ' days')::interval)`,
        ),
      )
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const row of batch) {
      allDeletedIds.push(row.id);
      if (!companyId) companyId = row.companyId;
      if (!timeRangeStart || row.startTime < timeRangeStart) timeRangeStart = row.startTime;
      if (!timeRangeEnd || row.startTime > timeRangeEnd) timeRangeEnd = row.startTime;
    }

    // Delete this batch
    const batchIds = batch.map((r) => r.id);
    await db
      .delete(auditSpans)
      .where(sql`${auditSpans.id} = ANY(${batchIds})`);

    iterations++;
  }

  if (allDeletedIds.length === 0) {
    return { deletedCount: 0, certificateId: null };
  }

  // Create deletion certificate
  const [cert] = await db
    .insert(auditDeletionCertificates)
    .values({
      companyId: companyId!,
      reason: "lifecycle_expiry",
      deletedSpansHash: hashSpanIds(allDeletedIds),
      deletedSpanCount: allDeletedIds.length,
      timeRangeStart: timeRangeStart!,
      timeRangeEnd: timeRangeEnd!,
      storageTier: "cold",
      deletedBy: "system:lifecycle",
    })
    .returning({ id: auditDeletionCertificates.id });

  logger.info(
    {
      deletedCount: allDeletedIds.length,
      certificateId: cert.id,
      coldRetentionDays,
    },
    "Deleted expired cold-tier audit spans with certificate",
  );

  return { deletedCount: allDeletedIds.length, certificateId: cert.id };
}

// ── Combined Lifecycle Sweep ────────────────────────────────────

export interface LifecycleSweepResult {
  hotToCold: MigrationResult;
  coldDeleted: DeletionResult;
}

/**
 * Run both lifecycle transitions in sequence:
 *   1. hot → cold
 *   2. cold → delete
 */
export async function runLifecycleSweep(
  db: Db,
  opts?: { hotRetentionDays?: number; coldRetentionDays?: number },
): Promise<LifecycleSweepResult> {
  const hotToCold = await migrateHotToCold(db, opts?.hotRetentionDays);
  const coldDeleted = await deleteColdSpans(db, opts?.coldRetentionDays);

  return { hotToCold, coldDeleted };
}

// ── Periodic Runner ─────────────────────────────────────────────

/**
 * Start a periodic audit span lifecycle sweep.
 *
 * @param db - Database connection
 * @param intervalMs - How often to run (default: 6 hours)
 * @returns A cleanup function that stops the interval
 */
export function startAuditStorageLifecycle(
  db: Db,
  intervalMs: number = 6 * 60 * 60 * 1_000,
): () => void {
  const timer = setInterval(() => {
    runLifecycleSweep(db).catch((err) => {
      logger.warn({ err }, "Audit storage lifecycle sweep failed");
    });
  }, intervalMs);

  // Run once on startup
  runLifecycleSweep(db).catch((err) => {
    logger.warn({ err }, "Initial audit storage lifecycle sweep failed");
  });

  return () => clearInterval(timer);
}
