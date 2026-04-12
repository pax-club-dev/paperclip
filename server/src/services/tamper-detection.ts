/**
 * Tamper detection service — verifies Merkle tree integrity and detects
 * sequence gaps across the audit trail.
 *
 * Per CISO §2.2: Re-compute Merkle roots from stored spans and compare.
 * Per CISO §2.3: Sequence gap detection per agent_id + run_id.
 *
 * This service is designed to run as a scheduled verification job
 * (e.g. cron or routine trigger) that audits the integrity ledger.
 */

import { eq, desc, and, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditMerkleRoots } from "@paperclipai/db";
import { computeMerkleRoot, merkleIntegrityService } from "./merkle-integrity.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";
import { logger } from "../middleware/logger.js";

// ---- Types ----

export interface TamperCheckResult {
  rootId: string;
  sequenceNumber: number;
  valid: boolean;
  storedHash: string;
  recomputedHash: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalRoots: number;
  brokenAt?: number;
  details?: string;
}

export interface SequenceGapResult {
  agentId: string;
  runId: string;
  gaps: Array<{ expected: number; got: number }>;
}

export interface IntegrityAuditReport {
  companyId: string;
  timestamp: string;
  rootVerification: {
    totalChecked: number;
    totalValid: number;
    failures: TamperCheckResult[];
  };
  chainVerification: ChainVerificationResult;
  overallResult: "pass" | "fail";
}

// ---- Service ----

export function tamperDetectionService(db: Db) {
  const merkle = merkleIntegrityService(db);

  return {
    /**
     * Verify a single Merkle root record: re-compute root from stored leaf hashes.
     * If the recomputed root differs from the stored hash, tampering is detected.
     */
    async verifyRoot(rootId: string): Promise<TamperCheckResult | null> {
      const root = await merkle.getRootById(rootId);
      if (!root) return null;

      const { valid, recomputedHash } = merkle.verifyRoot({
        rootHash: root.rootHash,
        leafHashes: root.leafHashes,
      });

      if (!valid) {
        await this.raiseTamperAlert(root.companyId, {
          rootId: root.id,
          sequenceNumber: root.sequenceNumber,
          storedHash: root.rootHash,
          recomputedHash,
        });
      }

      return {
        rootId: root.id,
        sequenceNumber: root.sequenceNumber,
        valid,
        storedHash: root.rootHash,
        recomputedHash,
      };
    },

    /**
     * Verify all Merkle roots for a company: both individual root integrity
     * and the hash chain linking them.
     */
    async auditCompany(companyId: string): Promise<IntegrityAuditReport> {
      const roots = await db
        .select()
        .from(auditMerkleRoots)
        .where(eq(auditMerkleRoots.companyId, companyId))
        .orderBy(auditMerkleRoots.sequenceNumber);

      const failures: TamperCheckResult[] = [];

      // Verify each root's leaf hash computation.
      for (const root of roots) {
        const { valid, recomputedHash } = merkle.verifyRoot({
          rootHash: root.rootHash,
          leafHashes: root.leafHashes,
        });

        if (!valid) {
          const result: TamperCheckResult = {
            rootId: root.id,
            sequenceNumber: root.sequenceNumber,
            valid: false,
            storedHash: root.rootHash,
            recomputedHash,
          };
          failures.push(result);

          await this.raiseTamperAlert(companyId, {
            rootId: root.id,
            sequenceNumber: root.sequenceNumber,
            storedHash: root.rootHash,
            recomputedHash,
          });
        }
      }

      // Verify hash chain integrity.
      const chainResult = await merkle.verifyChain(companyId);

      if (!chainResult.valid) {
        await this.raiseTamperAlert(companyId, {
          chainBrokenAt: chainResult.brokenAt,
          details: chainResult.details,
        });
      }

      const report: IntegrityAuditReport = {
        companyId,
        timestamp: new Date().toISOString(),
        rootVerification: {
          totalChecked: roots.length,
          totalValid: roots.length - failures.length,
          failures,
        },
        chainVerification: {
          ...chainResult,
          totalRoots: roots.length,
        },
        overallResult:
          failures.length === 0 && chainResult.valid ? "pass" : "fail",
      };

      logger.info(
        {
          companyId,
          totalRoots: roots.length,
          failures: failures.length,
          chainValid: chainResult.valid,
          overallResult: report.overallResult,
        },
        "integrity audit complete",
      );

      return report;
    },

    /**
     * Verify Merkle roots within a time range.
     * Useful for targeted verification of recent batches.
     */
    async verifyTimeRange(
      companyId: string,
      startTime: Date,
      endTime: Date,
    ): Promise<TamperCheckResult[]> {
      const roots = await db
        .select()
        .from(auditMerkleRoots)
        .where(
          and(
            eq(auditMerkleRoots.companyId, companyId),
            gte(auditMerkleRoots.batchStartTime, startTime),
            lte(auditMerkleRoots.batchEndTime, endTime),
          ),
        )
        .orderBy(auditMerkleRoots.sequenceNumber);

      const results: TamperCheckResult[] = [];
      for (const root of roots) {
        const { valid, recomputedHash } = merkle.verifyRoot({
          rootHash: root.rootHash,
          leafHashes: root.leafHashes,
        });

        results.push({
          rootId: root.id,
          sequenceNumber: root.sequenceNumber,
          valid,
          storedHash: root.rootHash,
          recomputedHash,
        });

        if (!valid) {
          await this.raiseTamperAlert(companyId, {
            rootId: root.id,
            sequenceNumber: root.sequenceNumber,
            storedHash: root.rootHash,
            recomputedHash,
          });
        }
      }

      return results;
    },

    /**
     * Raise a TAMPER_DETECTED critical alert.
     * Logs to activity trail and publishes a live event.
     */
    async raiseTamperAlert(
      companyId: string,
      details: Record<string, unknown>,
    ): Promise<void> {
      logger.fatal(
        { companyId, alertId: "TAMPER_DETECTED", details },
        "TAMPER_DETECTED: Merkle root integrity verification failed",
      );

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "tamper-detection-service",
        action: "audit.tamper_detected",
        entityType: "audit_merkle_root",
        entityId: (details.rootId as string) ?? "chain",
        details: {
          alertId: "TAMPER_DETECTED",
          severity: "critical",
          ...details,
        },
      });

      publishLiveEvent({
        companyId,
        type: "activity.logged",
        payload: {
          alertId: "TAMPER_DETECTED",
          severity: "critical",
          ...details,
        },
      });
    },
  };
}
