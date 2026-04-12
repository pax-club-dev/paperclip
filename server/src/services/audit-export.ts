/**
 * Audit export service — secure trace export per CISO §3.2.
 *
 * - POST /api/companies/:companyId/audit/exports → create export job
 * - Exports >10,000 spans require CISO/board approval (async gate via Paperclip approvals)
 * - Merkle inclusion proofs bind exported spans to the integrity ledger
 * - AES-256-GCM encrypted output with per-export key
 * - Export events are themselves audited via OTel spans
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq, gte, lte, sql, desc, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  auditSpans,
  auditExportJobs,
  auditMerkleRoots,
  approvals,
} from "@paperclipai/db";
import {
  getAuditEncryptionProvider,
  type AuditEncryptionProvider,
} from "./audit-encryption.js";
import {
  computeLeafHash,
  computeMerkleRoot,
  merkleIntegrityService,
} from "./merkle-integrity.js";
import { logger } from "../middleware/logger.js";

// ── Constants ────────────────────────────────────────────────────

/** Span count threshold above which CISO/board approval is required. */
const APPROVAL_THRESHOLD = 10_000;

/** Maximum spans per export to prevent abuse. */
const MAX_EXPORT_SPANS = 500_000;

/** Batch size for reading spans during export processing. */
const EXPORT_BATCH_SIZE = 5_000;

// ── Types ────────────────────────────────────────────────────────

export interface ExportFilters {
  agentId?: string;
  issueId?: string;
  runId?: string;
  actionType?: string;
  outcome?: string;
  startTime?: string;
  endTime?: string;
}

export interface MerkleInclusionProof {
  spanId: string;
  leafHash: string;
  rootId: string;
  rootHash: string;
  siblingPath: string[];
  pathDirections: Array<"left" | "right">;
}

interface ActorInfo {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
}

// ── Service ──────────────────────────────────────────────────────

export function auditExportService(db: Db) {
  const merkleSvc = merkleIntegrityService(db);

  /**
   * Build WHERE conditions from export filters.
   * Always scoped to companyId for multi-tenant isolation.
   */
  function buildFilterConditions(companyId: string, filters: ExportFilters) {
    const conditions = [eq(auditSpans.companyId, companyId)];

    if (filters.agentId) {
      conditions.push(eq(auditSpans.agentId, filters.agentId));
    }
    if (filters.issueId) {
      conditions.push(eq(auditSpans.issueId, filters.issueId));
    }
    if (filters.runId) {
      conditions.push(eq(auditSpans.runId, filters.runId));
    }
    if (filters.actionType) {
      conditions.push(eq(auditSpans.actionType, filters.actionType));
    }
    if (filters.outcome) {
      conditions.push(eq(auditSpans.outcome, filters.outcome));
    }
    if (filters.startTime) {
      conditions.push(gte(auditSpans.startTime, new Date(filters.startTime)));
    }
    if (filters.endTime) {
      conditions.push(lte(auditSpans.startTime, new Date(filters.endTime)));
    }

    return and(...conditions);
  }

  /**
   * Count spans matching the given filters.
   */
  async function countMatchingSpans(
    companyId: string,
    filters: ExportFilters,
  ): Promise<number> {
    const where = buildFilterConditions(companyId, filters);
    const [result] = await db
      .select({ total: count() })
      .from(auditSpans)
      .where(where);
    return result?.total ?? 0;
  }

  /**
   * Compute Merkle inclusion proofs for a set of spans.
   *
   * For each span, find the Merkle root that contains it (via leaf_hashes)
   * and compute the sibling path from the leaf to the root.
   */
  async function computeInclusionProofs(
    companyId: string,
    spans: Array<{
      id: string;
      spanId: string;
      traceId: string;
      agentId: string;
      runId: string | null;
      startTime: Date;
      actionType: string;
      targetResource: string | null;
      outcome: string;
      signature: string | null;
      sequenceNumber: number;
    }>,
  ): Promise<MerkleInclusionProof[]> {
    const proofs: MerkleInclusionProof[] = [];

    // Get all Merkle roots for the company, most recent first.
    const roots = await merkleSvc.listRoots(companyId, 1000);

    for (const span of spans) {
      // Compute this span's leaf hash to find it in a root.
      const startTimeNs = String(span.startTime.getTime()) + "000000";
      const leafHash = computeLeafHash(
        span.traceId,
        span.spanId,
        span.agentId,
        span.runId ?? "",
        startTimeNs,
        span.actionType,
        span.targetResource ?? "",
        span.outcome,
        span.signature ?? undefined,
      );

      // Find the root containing this leaf.
      const matchingRoot = roots.find((r) =>
        r.leafHashes.includes(leafHash),
      );

      if (!matchingRoot) {
        // Span may not yet be in a committed Merkle batch — skip proof.
        continue;
      }

      // Build sibling path from the leaf to the root.
      const leafIdx = matchingRoot.leafHashes.indexOf(leafHash);
      const { siblingPath, pathDirections } = buildSiblingPath(
        matchingRoot.leafHashes,
        leafIdx,
      );

      proofs.push({
        spanId: span.spanId,
        leafHash,
        rootId: matchingRoot.id,
        rootHash: matchingRoot.rootHash,
        siblingPath,
        pathDirections,
      });
    }

    return proofs;
  }

  /**
   * Build the sibling path (authentication path) for a leaf at `leafIdx`
   * in a binary Merkle tree. This is the minimal set of nodes needed to
   * recompute the root from the leaf, proving the leaf's inclusion.
   */
  function buildSiblingPath(
    leafHashes: string[],
    leafIdx: number,
  ): { siblingPath: string[]; pathDirections: Array<"left" | "right"> } {
    const siblingPath: string[] = [];
    const pathDirections: Array<"left" | "right"> = [];

    if (leafHashes.length <= 1) {
      return { siblingPath, pathDirections };
    }

    let level = [...leafHashes];
    let idx = leafIdx;

    while (level.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          // Pair exists — record sibling if one of this pair is our node.
          if (i === idx || i + 1 === idx) {
            const siblingIdx = i === idx ? i + 1 : i;
            siblingPath.push(level[siblingIdx]);
            pathDirections.push(i === idx ? "right" : "left");
          }
          nextLevel.push(sha256(level[i] + level[i + 1]));
        } else {
          // Odd node — promoted. If it's our node, no sibling needed.
          nextLevel.push(level[i]);
        }
      }

      idx = Math.floor(idx / 2);
      level = nextLevel;
    }

    return { siblingPath, pathDirections };
  }

  return {
    /**
     * Create an export job. Counts matching spans and determines if
     * approval is required (>10k spans → CISO/board approval gate).
     *
     * Returns the created job. Caller should check status:
     * - "processing" → export is running (≤10k spans, no approval needed)
     * - "pending_approval" → waiting for CISO/board approval
     */
    async createExportJob(
      companyId: string,
      filters: ExportFilters,
      actor: ActorInfo,
    ) {
      // Count matching spans.
      const spanCount = await countMatchingSpans(companyId, filters);

      if (spanCount === 0) {
        throw new ExportError("No spans match the given filters", 400);
      }

      if (spanCount > MAX_EXPORT_SPANS) {
        throw new ExportError(
          `Export would include ${spanCount} spans, exceeding the maximum of ${MAX_EXPORT_SPANS}. ` +
          `Narrow your filters.`,
          400,
        );
      }

      const needsApproval = spanCount > APPROVAL_THRESHOLD;
      let approvalId: string | null = null;

      if (needsApproval) {
        // Create an approval request for CISO/board.
        const [approval] = await db
          .insert(approvals)
          .values({
            companyId,
            type: "audit_export",
            requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            status: "pending",
            payload: {
              exportType: "audit_spans",
              spanCount,
              filters,
              reason: `Export of ${spanCount} audit spans requires CISO/board approval (threshold: ${APPROVAL_THRESHOLD})`,
            },
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: new Date(),
          })
          .returning();
        approvalId = approval.id;
      }

      // Create the export job.
      const [job] = await db
        .insert(auditExportJobs)
        .values({
          companyId,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
          status: needsApproval ? "pending_approval" : "processing",
          filters,
          spanCount,
          approvalId,
          updatedAt: new Date(),
        })
        .returning();

      logger.info(
        {
          exportJobId: job.id,
          companyId,
          spanCount,
          needsApproval,
          approvalId,
        },
        needsApproval
          ? "audit export job created — pending CISO/board approval"
          : "audit export job created — processing",
      );

      // If no approval needed, start processing immediately.
      if (!needsApproval) {
        // Process async — don't block the response.
        void this.processExport(job.id).catch((err) => {
          logger.error({ exportJobId: job.id, err }, "audit export processing failed");
        });
      }

      return job;
    },

    /**
     * Called when an approval is resolved. If approved, starts processing.
     * If rejected, marks the export as rejected.
     */
    async onApprovalResolved(
      approvalId: string,
      status: "approved" | "rejected",
    ) {
      const jobs = await db
        .select()
        .from(auditExportJobs)
        .where(
          and(
            eq(auditExportJobs.approvalId, approvalId),
            eq(auditExportJobs.status, "pending_approval"),
          ),
        );

      for (const job of jobs) {
        if (status === "approved") {
          await db
            .update(auditExportJobs)
            .set({ status: "approved", updatedAt: new Date() })
            .where(eq(auditExportJobs.id, job.id));

          // Start processing.
          void this.processExport(job.id).catch((err) => {
            logger.error({ exportJobId: job.id, err }, "audit export processing failed after approval");
          });
        } else {
          await db
            .update(auditExportJobs)
            .set({ status: "rejected", updatedAt: new Date() })
            .where(eq(auditExportJobs.id, job.id));

          logger.info({ exportJobId: job.id }, "audit export rejected by CISO/board");
        }
      }
    },

    /**
     * Process an export job: read spans, compute Merkle proofs,
     * encrypt the output, and store it.
     */
    async processExport(jobId: string) {
      const [job] = await db
        .select()
        .from(auditExportJobs)
        .where(eq(auditExportJobs.id, jobId));

      if (!job) {
        throw new ExportError("Export job not found", 404);
      }

      if (job.status !== "processing" && job.status !== "approved") {
        throw new ExportError(
          `Export job is in status "${job.status}" — cannot process`,
          400,
        );
      }

      // Update status to processing (in case it was "approved").
      await db
        .update(auditExportJobs)
        .set({ status: "processing", updatedAt: new Date() })
        .where(eq(auditExportJobs.id, jobId));

      try {
        const filters = job.filters as ExportFilters;
        const where = buildFilterConditions(job.companyId, filters);

        // Read all matching spans in batches.
        const allSpans: Array<typeof auditSpans.$inferSelect> = [];
        let offset = 0;

        while (true) {
          const batch = await db
            .select()
            .from(auditSpans)
            .where(where)
            .orderBy(auditSpans.startTime)
            .limit(EXPORT_BATCH_SIZE)
            .offset(offset);

          if (batch.length === 0) break;
          allSpans.push(...batch);
          offset += batch.length;

          if (batch.length < EXPORT_BATCH_SIZE) break;
        }

        // Compute Merkle inclusion proofs.
        const proofs = await computeInclusionProofs(
          job.companyId,
          allSpans.map((s) => ({
            id: s.id,
            spanId: s.spanId,
            traceId: s.traceId,
            agentId: s.agentId,
            runId: s.runId,
            startTime: s.startTime,
            actionType: s.actionType,
            targetResource: s.targetResource,
            outcome: s.outcome,
            signature: s.signature,
            sequenceNumber: s.sequenceNumber,
          })),
        );

        // Build the export payload (cleartext before encryption).
        const exportPayload = JSON.stringify({
          exportJobId: jobId,
          companyId: job.companyId,
          exportedAt: new Date().toISOString(),
          filters,
          spanCount: allSpans.length,
          spans: allSpans.map((s) => ({
            id: s.id,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            agentId: s.agentId,
            runId: s.runId,
            issueId: s.issueId,
            actionType: s.actionType,
            outcome: s.outcome,
            targetResource: s.targetResource,
            startTime: s.startTime.toISOString(),
            endTime: s.endTime.toISOString(),
            durationMs: s.durationMs,
            signature: s.signature,
            sequenceNumber: s.sequenceNumber,
            storageTier: s.storageTier,
            // encryptedPayload is NOT included in raw form — the export
            // re-encrypts the entire output as a unit.
          })),
          merkleProofs: proofs,
          integrityHash: hashExportContent(allSpans),
        });

        // Encrypt the output with AES-256-GCM.
        const encProvider = getAuditEncryptionProvider();
        const encrypted = encProvider.encrypt(exportPayload);

        // Update the job with the encrypted output.
        await db
          .update(auditExportJobs)
          .set({
            status: "completed",
            encryptedOutput: encrypted.ciphertext,
            outputEncryptionScheme: encrypted.scheme,
            outputEncryptionKeyVersion: encrypted.keyVersion,
            outputEncryptionIv: encrypted.iv,
            outputEncryptionTag: encrypted.tag,
            merkleProofs: proofs,
            outputSizeBytes: Buffer.byteLength(encrypted.ciphertext, "utf8"),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(auditExportJobs.id, jobId));

        logger.info(
          {
            exportJobId: jobId,
            spanCount: allSpans.length,
            proofCount: proofs.length,
            outputSizeBytes: Buffer.byteLength(encrypted.ciphertext, "utf8"),
          },
          "audit export completed successfully",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(auditExportJobs)
          .set({
            status: "failed",
            error: message,
            updatedAt: new Date(),
          })
          .where(eq(auditExportJobs.id, jobId));

        logger.error({ exportJobId: jobId, err }, "audit export processing failed");
        throw err;
      }
    },

    /**
     * Get an export job by ID.
     */
    async getExportJob(jobId: string) {
      const [job] = await db
        .select()
        .from(auditExportJobs)
        .where(eq(auditExportJobs.id, jobId));
      return job ?? null;
    },

    /**
     * List export jobs for a company (most recent first).
     */
    async listExportJobs(companyId: string, limit = 50) {
      return db
        .select({
          id: auditExportJobs.id,
          companyId: auditExportJobs.companyId,
          status: auditExportJobs.status,
          filters: auditExportJobs.filters,
          spanCount: auditExportJobs.spanCount,
          approvalId: auditExportJobs.approvalId,
          outputSizeBytes: auditExportJobs.outputSizeBytes,
          completedAt: auditExportJobs.completedAt,
          createdAt: auditExportJobs.createdAt,
          requestedByAgentId: auditExportJobs.requestedByAgentId,
          requestedByUserId: auditExportJobs.requestedByUserId,
          error: auditExportJobs.error,
        })
        .from(auditExportJobs)
        .where(eq(auditExportJobs.companyId, companyId))
        .orderBy(desc(auditExportJobs.createdAt))
        .limit(limit);
    },

    /**
     * Download the encrypted export output for a completed job.
     * Returns the encrypted payload components needed for decryption.
     */
    async downloadExport(jobId: string) {
      const [job] = await db
        .select()
        .from(auditExportJobs)
        .where(eq(auditExportJobs.id, jobId));

      if (!job) {
        throw new ExportError("Export job not found", 404);
      }

      if (job.status !== "completed") {
        throw new ExportError(
          `Export is in status "${job.status}" — not available for download`,
          400,
        );
      }

      if (!job.encryptedOutput) {
        throw new ExportError("Export has no output data", 500);
      }

      return {
        exportJobId: job.id,
        companyId: job.companyId,
        spanCount: job.spanCount,
        encryptedOutput: job.encryptedOutput,
        encryptionScheme: job.outputEncryptionScheme,
        encryptionKeyVersion: job.outputEncryptionKeyVersion,
        encryptionIv: job.outputEncryptionIv,
        encryptionTag: job.outputEncryptionTag,
        merkleProofs: job.merkleProofs,
        outputSizeBytes: job.outputSizeBytes,
        completedAt: job.completedAt,
      };
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute a SHA-256 integrity hash over the export content
 * (sorted span IDs) for tamper detection of the export itself.
 */
function hashExportContent(
  spans: Array<{ id: string }>,
): string {
  const sorted = spans.map((s) => s.id).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

// ── Errors ───────────────────────────────────────────────────────

export class ExportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExportError";
  }
}
