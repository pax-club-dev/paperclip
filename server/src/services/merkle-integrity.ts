/**
 * Merkle tree integrity service — batch span hashing and append-only root storage.
 *
 * Per CISO §2.2: Append-only integrity ledger with Merkle tree verification.
 * Per CISO §2.3: Sequence gap detection per agent_id + run_id.
 *
 * Architecture:
 *   MerkleIntegrityProcessor (SpanProcessor) sits in the OTel pipeline.
 *   On each span end, it computes a SHA-256 leaf hash from the canonical fields.
 *   When the buffer reaches 1000 spans or 60s elapses, it computes the Merkle
 *   tree root and stores it in the audit_merkle_roots table (append-only).
 *
 *   Each root chains to the previous root via previousRootHash, forming a
 *   hash chain that makes retroactive tampering detectable.
 */

import { createHash } from "node:crypto";
import { eq, desc, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditMerkleRoots } from "@paperclipai/db";
import {
  AUDIT_ATTR,
  type AuditAlertId,
} from "@paperclipai/shared/telemetry/audit-types.js";
import {
  buildCanonicalPayload,
  hrTimeToNanosString,
} from "@paperclipai/shared/telemetry/signing-span-processor.js";
import { logger } from "../middleware/logger.js";

// ---- Merkle tree computation ----

/**
 * Compute SHA-256 hash of a buffer, returning hex string.
 */
function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute a leaf hash from a span's canonical fields.
 * Uses the same canonical payload as the signing processor (CISO §2.1)
 * to ensure consistency between signing and integrity verification.
 */
export function computeLeafHash(
  traceId: string,
  spanId: string,
  agentId: string,
  runId: string,
  startTimeNs: string,
  actionType: string,
  targetResource: string,
  outcome: string,
  signature?: string,
): string {
  const canonical = buildCanonicalPayload(
    traceId,
    spanId,
    agentId,
    runId,
    startTimeNs,
    actionType,
    targetResource,
    outcome,
  );
  // Include the Ed25519 signature in the leaf hash if present,
  // binding the Merkle integrity to the signing layer.
  const toHash = signature
    ? Buffer.concat([canonical, Buffer.from("|"), Buffer.from(signature, "utf8")])
    : canonical;
  return sha256(toHash);
}

/**
 * Compute a Merkle tree root from an array of leaf hashes.
 *
 * Uses a standard binary Merkle tree with SHA-256.
 * - Odd leaf counts: the last leaf is promoted (not duplicated) to avoid
 *   second-preimage attacks inherent in hash-duplication schemes.
 * - Empty input returns a well-known empty root.
 */
export function computeMerkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) {
    return sha256("EMPTY_MERKLE_TREE");
  }
  if (leafHashes.length === 1) {
    return leafHashes[0];
  }

  let level = [...leafHashes];

  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        // Hash pair of sibling nodes
        nextLevel.push(sha256(level[i] + level[i + 1]));
      } else {
        // Odd node — promote without duplication
        nextLevel.push(level[i]);
      }
    }
    level = nextLevel;
  }

  return level[0];
}

// ---- Per-company buffer for batching spans ----

interface CompanyBuffer {
  leaves: string[];
  startTime: Date;
  /** Sequence numbers seen per agent_id:run_id for gap detection. */
  sequenceNumbers: Map<string, number[]>;
}

/** Default batch threshold: 1000 spans or 60s. */
const MAX_BATCH_SIZE = 1000;
const BATCH_INTERVAL_MS = 60_000;

// ---- MerkleIntegrityProcessor (OTel SpanProcessor) ----

type ReadableSpan = import("@opentelemetry/sdk-trace-base").ReadableSpan;
type SpanProcessor = import("@opentelemetry/sdk-trace-base").SpanProcessor;
type Span = import("@opentelemetry/sdk-trace-base").Span;
type Context = import("@opentelemetry/api").Context;

export interface MerkleProcessorOptions {
  db: Db;
  maxBatchSize?: number;
  batchIntervalMs?: number;
  /** Callback invoked on alerts (TAMPER_DETECTED, SEQUENCE_GAP). */
  onAlert?: (alert: { id: AuditAlertId; companyId: string; details: Record<string, unknown> }) => void;
}

/**
 * OTel SpanProcessor that accumulates span leaf hashes per company and
 * periodically commits Merkle tree roots to the append-only ledger.
 */
export class MerkleIntegrityProcessor implements SpanProcessor {
  private readonly db: Db;
  private readonly maxBatchSize: number;
  private readonly batchIntervalMs: number;
  private readonly onAlert: MerkleProcessorOptions["onAlert"];
  private readonly buffers = new Map<string, CompanyBuffer>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(options: MerkleProcessorOptions) {
    this.db = options.db;
    this.maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
    this.batchIntervalMs = options.batchIntervalMs ?? BATCH_INTERVAL_MS;
    this.onAlert = options.onAlert;

    // Periodic flush for time-based batching.
    this.flushTimer = setInterval(() => {
      void this.flushAll();
    }, this.batchIntervalMs);
    // Don't block Node.js shutdown.
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No action on start.
  }

  onEnd(span: ReadableSpan): void {
    if (this.shuttingDown) return;

    const attrs = span.attributes;
    const companyId = attrs[AUDIT_ATTR.COMPANY_ID];
    const runId = attrs[AUDIT_ATTR.RUN_ID];
    if (typeof companyId !== "string" || !companyId) return;
    if (typeof runId !== "string" || !runId) return;

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    const agentId = (attrs[AUDIT_ATTR.AGENT_ID] as string) ?? "";
    const startTimeNs = hrTimeToNanosString(span.startTime as [number, number]);
    const actionType = (attrs[AUDIT_ATTR.ACTION_TYPE] as string) ?? "";
    const targetResource = (attrs[AUDIT_ATTR.TARGET_RESOURCE] as string) ?? "";
    const outcome = (attrs[AUDIT_ATTR.OUTCOME] as string) ?? "";
    const signature = (attrs[AUDIT_ATTR.SPAN_SIGNATURE] as string) ?? undefined;

    const leafHash = computeLeafHash(
      traceId,
      spanId,
      agentId,
      runId,
      startTimeNs,
      actionType,
      targetResource,
      outcome,
      signature,
    );

    let buffer = this.buffers.get(companyId);
    if (!buffer) {
      buffer = { leaves: [], startTime: new Date(), sequenceNumbers: new Map() };
      this.buffers.set(companyId, buffer);
    }

    buffer.leaves.push(leafHash);

    // Track sequence numbers for gap detection (CISO §2.3).
    const seqNum = attrs[AUDIT_ATTR.SEQUENCE_NUMBER];
    if (typeof seqNum === "number") {
      const key = `${agentId}:${runId}`;
      let seqs = buffer.sequenceNumbers.get(key);
      if (!seqs) {
        seqs = [];
        buffer.sequenceNumbers.set(key, seqs);
      }
      seqs.push(seqNum);
    }

    // Flush if batch size reached.
    if (buffer.leaves.length >= this.maxBatchSize) {
      void this.flushCompany(companyId);
    }
  }

  async forceFlush(): Promise<void> {
    await this.flushAll();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushAll();
  }

  // ---- Internal flush logic ----

  private async flushAll(): Promise<void> {
    const companyIds = [...this.buffers.keys()];
    for (const companyId of companyIds) {
      await this.flushCompany(companyId);
    }
  }

  private async flushCompany(companyId: string): Promise<void> {
    const buffer = this.buffers.get(companyId);
    if (!buffer || buffer.leaves.length === 0) return;

    // Take the buffer and reset.
    const leaves = buffer.leaves;
    const startTime = buffer.startTime;
    const sequenceNumbers = buffer.sequenceNumbers;
    this.buffers.set(companyId, {
      leaves: [],
      startTime: new Date(),
      sequenceNumbers: new Map(),
    });

    const endTime = new Date();

    try {
      // Check for sequence gaps before storing (CISO §2.3).
      this.detectSequenceGapsInBatch(companyId, sequenceNumbers);

      // Compute Merkle root.
      const rootHash = computeMerkleRoot(leaves);

      // Get previous root for chaining.
      const previousRoot = await this.getLatestRoot(companyId);
      const previousRootHash = previousRoot?.rootHash ?? null;
      const nextSequence = (previousRoot?.sequenceNumber ?? 0) + 1;

      // Append to ledger (insert only — never update).
      await this.db.insert(auditMerkleRoots).values({
        companyId,
        rootHash,
        previousRootHash: previousRootHash,
        batchStartTime: startTime,
        batchEndTime: endTime,
        spanCount: leaves.length,
        leafHashes: leaves,
        sequenceNumber: nextSequence,
      });

      logger.info(
        {
          companyId,
          rootHash,
          spanCount: leaves.length,
          sequenceNumber: nextSequence,
        },
        "merkle root committed to integrity ledger",
      );
    } catch (err) {
      logger.error(
        { companyId, spanCount: leaves.length, err },
        "failed to commit merkle root — spans may lack integrity proof",
      );
    }
  }

  private async getLatestRoot(companyId: string) {
    const rows = await this.db
      .select({
        rootHash: auditMerkleRoots.rootHash,
        sequenceNumber: auditMerkleRoots.sequenceNumber,
      })
      .from(auditMerkleRoots)
      .where(eq(auditMerkleRoots.companyId, companyId))
      .orderBy(desc(auditMerkleRoots.sequenceNumber))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Detect sequence gaps within a batch per agent_id:run_id (CISO §2.3).
   * Gaps indicate dropped or reordered spans, which may signal tampering.
   */
  private detectSequenceGapsInBatch(
    companyId: string,
    sequenceNumbers: Map<string, number[]>,
  ): void {
    for (const [key, seqs] of sequenceNumbers) {
      if (seqs.length < 2) continue;

      const sorted = [...seqs].sort((a, b) => a - b);
      const gaps: Array<{ expected: number; got: number }> = [];

      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) {
          gaps.push({ expected: sorted[i - 1] + 1, got: sorted[i] });
        }
      }

      if (gaps.length > 0) {
        const [agentId, runId] = key.split(":");
        logger.warn(
          { companyId, agentId, runId, gaps },
          "SEQUENCE_GAP detected in audit span batch",
        );
        this.onAlert?.({
          id: "SEQUENCE_GAP",
          companyId,
          details: { agentId, runId, gaps },
        });
      }
    }
  }
}

// ---- Merkle integrity service (query + verification) ----

export function merkleIntegrityService(db: Db) {
  return {
    /**
     * Get the latest Merkle root for a company.
     */
    async getLatestRoot(companyId: string) {
      const rows = await db
        .select()
        .from(auditMerkleRoots)
        .where(eq(auditMerkleRoots.companyId, companyId))
        .orderBy(desc(auditMerkleRoots.sequenceNumber))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Get a Merkle root by ID.
     */
    async getRootById(rootId: string) {
      const rows = await db
        .select()
        .from(auditMerkleRoots)
        .where(eq(auditMerkleRoots.id, rootId))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * List Merkle roots for a company in reverse chronological order.
     */
    async listRoots(companyId: string, limit = 50) {
      return db
        .select()
        .from(auditMerkleRoots)
        .where(eq(auditMerkleRoots.companyId, companyId))
        .orderBy(desc(auditMerkleRoots.sequenceNumber))
        .limit(limit);
    },

    /**
     * Verify a stored Merkle root by recomputing from its leaf hashes.
     * Returns true if the recomputed root matches the stored root hash.
     */
    verifyRoot(root: {
      rootHash: string;
      leafHashes: string[];
    }): { valid: boolean; recomputedHash: string } {
      const recomputedHash = computeMerkleRoot(root.leafHashes);
      return {
        valid: recomputedHash === root.rootHash,
        recomputedHash,
      };
    },

    /**
     * Verify the hash chain: each root's previousRootHash must match
     * the preceding root's rootHash. Returns the first broken link or null.
     */
    async verifyChain(
      companyId: string,
    ): Promise<{ valid: boolean; brokenAt?: number; details?: string }> {
      const roots = await db
        .select({
          sequenceNumber: auditMerkleRoots.sequenceNumber,
          rootHash: auditMerkleRoots.rootHash,
          previousRootHash: auditMerkleRoots.previousRootHash,
        })
        .from(auditMerkleRoots)
        .where(eq(auditMerkleRoots.companyId, companyId))
        .orderBy(auditMerkleRoots.sequenceNumber);

      for (let i = 1; i < roots.length; i++) {
        if (roots[i].previousRootHash !== roots[i - 1].rootHash) {
          return {
            valid: false,
            brokenAt: roots[i].sequenceNumber,
            details: `Chain break at sequence ${roots[i].sequenceNumber}: ` +
              `expected previousRootHash=${roots[i - 1].rootHash}, ` +
              `got ${roots[i].previousRootHash}`,
          };
        }
      }

      // First root should have no previous hash.
      if (roots.length > 0 && roots[0].previousRootHash !== null) {
        return {
          valid: false,
          brokenAt: roots[0].sequenceNumber,
          details: "First root has a non-null previousRootHash",
        };
      }

      return { valid: true };
    },
  };
}
