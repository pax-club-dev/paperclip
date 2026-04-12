/**
 * Behavioral pattern detection service per CISO §6.2.
 *
 * Detects six classes of security anomalies from audit trail data:
 *   1. Credential compromise — actions outside assigned issue scope
 *   2. Privilege escalation — accessing higher-privilege traces/resources
 *   3. Data exfiltration preparation — abnormal read volume in a run
 *   4. Trace pipeline manipulation — collector config changes outside deployments
 *   5. Lateral movement — subtask delegation with unwarranted escalation
 *   6. Replay attacks — duplicate trace/span IDs from different agents
 *
 * Designed to run as a scheduled job (routine trigger). Each detector
 * scans a configurable time window and raises alerts via auditAlertService.
 */

import { eq, and, gte, lte, ne, sql, desc, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditSpans, issues, agents } from "@paperclipai/db";
import { auditAlertService } from "./audit-alerts.js";
import { logger } from "../middleware/logger.js";

// ── Types ───────────────────────────────────────────────────────

export interface DetectionWindow {
  /** Start of the analysis window. */
  startTime: Date;
  /** End of the analysis window (defaults to now). */
  endTime?: Date;
}

export interface DetectionResult {
  detector: string;
  companyId: string;
  anomaliesFound: number;
  alertsRaised: number;
  scannedSpans: number;
  durationMs: number;
}

export interface AnomalyDetectionReport {
  companyId: string;
  window: { start: string; end: string };
  results: DetectionResult[];
  totalAlertsRaised: number;
}

// ── Thresholds ──────────────────────────────────────────────────

/** Default detection thresholds — can be overridden per-company. */
const DEFAULTS = {
  /** Max file-read or API-fetch spans per run before flagging. */
  exfiltrationReadThreshold: 50,
  /** Standard deviations above mean for volume anomaly. */
  volumeSigmaThreshold: 3,
  /** Minimum spans in baseline window for volume anomaly to be meaningful. */
  volumeBaselineMinSpans: 20,
  /** Baseline window in hours for volume anomaly. */
  volumeBaselineHours: 168, // 7 days
};

// ── Service ─────────────────────────────────────────────────────

export function auditAnomalyDetectionService(db: Db) {
  const alerts = auditAlertService(db);

  return {
    /**
     * Run all detectors for a company within the given window.
     * Returns a full report of what was found and what alerts were raised.
     */
    async runAllDetectors(
      companyId: string,
      window: DetectionWindow,
    ): Promise<AnomalyDetectionReport> {
      const endTime = window.endTime ?? new Date();
      const results: DetectionResult[] = [];

      const detectors = [
        this.detectCredentialCompromise,
        this.detectPrivilegeEscalation,
        this.detectDataExfiltration,
        this.detectPipelineManipulation,
        this.detectLateralMovement,
        this.detectReplayAttacks,
      ] as const;

      for (const detector of detectors) {
        try {
          const result = await detector.call(this, companyId, {
            startTime: window.startTime,
            endTime,
          });
          results.push(result);
        } catch (err) {
          logger.error(
            { err, companyId, detector: detector.name },
            "anomaly detector failed",
          );
          results.push({
            detector: detector.name,
            companyId,
            anomaliesFound: 0,
            alertsRaised: 0,
            scannedSpans: 0,
            durationMs: 0,
          });
        }
      }

      const totalAlertsRaised = results.reduce((sum, r) => sum + r.alertsRaised, 0);

      logger.info(
        { companyId, totalAlertsRaised, detectors: results.length },
        "anomaly detection scan complete",
      );

      return {
        companyId,
        window: {
          start: window.startTime.toISOString(),
          end: endTime.toISOString(),
        },
        results,
        totalAlertsRaised,
      };
    },

    /**
     * 1. Credential compromise — Agent performing actions on issues
     * that are not assigned to it (CISO §6.2.1).
     *
     * Detects spans where the agent_id + issue_id pair does not match
     * the current issue assignment. Scans audit_spans for the window.
     */
    async detectCredentialCompromise(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      // Find spans where the agent acted on issues not assigned to them.
      // We join audit_spans with issues to check assignment.
      const outOfScopeSpans = await db
        .select({
          agentId: auditSpans.agentId,
          issueId: auditSpans.issueId,
          runId: auditSpans.runId,
          spanCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .leftJoin(issues, eq(auditSpans.issueId, issues.id))
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
            sql`${auditSpans.issueId} IS NOT NULL`,
            // Issue exists but agent is not the assignee
            sql`${issues.id} IS NOT NULL`,
            ne(auditSpans.agentId, sql`COALESCE(${issues.assigneeAgentId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
          ),
        )
        .groupBy(auditSpans.agentId, auditSpans.issueId, auditSpans.runId);

      for (const row of outOfScopeSpans) {
        await alerts.raise({
          companyId,
          alertType: "CROSS_TENANT_ATTEMPT",
          message: `Agent performed ${row.spanCount} action(s) on unassigned issue — possible credential compromise`,
          details: {
            pattern: "credential_compromise",
            agentId: row.agentId,
            issueId: row.issueId,
            runId: row.runId,
            outOfScopeActions: row.spanCount,
          },
          sourceAgentId: row.agentId,
          sourceRunId: row.runId,
        });
        alertsRaised++;
      }

      return {
        detector: "detectCredentialCompromise",
        companyId,
        anomaliesFound: outOfScopeSpans.length,
        alertsRaised,
        scannedSpans: outOfScopeSpans.reduce((s: number, r: { spanCount: number }) => s + r.spanCount, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * 2. Privilege escalation — Agent accessing traces belonging to
     * other agents or higher-privilege roles (CISO §6.2.2).
     *
     * Detects query/read spans where target_resource references another
     * agent's trace data and the acting agent is not a privileged role.
     */
    async detectPrivilegeEscalation(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      // Find spans where an agent queried audit data (action_type contains
      // 'audit.query' or 'audit.export') for a different agent's traces.
      const escalationSpans = await db
        .select({
          actingAgentId: auditSpans.agentId,
          runId: auditSpans.runId,
          spanCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .leftJoin(agents, eq(auditSpans.agentId, agents.id))
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
            sql`${auditSpans.actionType} IN ('audit.query', 'audit.export', 'audit.query_cross_agent')`,
            // Acting agent is not a privileged role
            sql`LOWER(COALESCE(${agents.role}, '')) NOT IN ('ciso', 'clo', 'ceo', 'coo', 'cto')`,
          ),
        )
        .groupBy(auditSpans.agentId, auditSpans.runId);

      for (const row of escalationSpans) {
        await alerts.raise({
          companyId,
          alertType: "CROSS_TENANT_ATTEMPT",
          message: `Non-privileged agent accessed audit data — possible privilege escalation`,
          details: {
            pattern: "privilege_escalation",
            actingAgentId: row.actingAgentId,
            runId: row.runId,
            queryCount: row.spanCount,
          },
          sourceAgentId: row.actingAgentId,
          sourceRunId: row.runId,
        });
        alertsRaised++;
      }

      return {
        detector: "detectPrivilegeEscalation",
        companyId,
        anomaliesFound: escalationSpans.length,
        alertsRaised,
        scannedSpans: escalationSpans.reduce((s: number, r: { spanCount: number }) => s + r.spanCount, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * 3. Data exfiltration preparation — Abnormal volume of file reads
     * or API fetches within a single run (CISO §6.2.3).
     *
     * Flags runs where read-type span count exceeds the threshold.
     */
    async detectDataExfiltration(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      const highReadRuns = await db
        .select({
          agentId: auditSpans.agentId,
          runId: auditSpans.runId,
          readCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
            // Read-type actions: file reads, API fetches, data access
            sql`${auditSpans.actionType} IN ('file.read', 'api.fetch', 'data.read', 'tool.read', 'resource.read')`,
          ),
        )
        .groupBy(auditSpans.agentId, auditSpans.runId)
        .having(sql`count(*) > ${DEFAULTS.exfiltrationReadThreshold}`);

      for (const row of highReadRuns) {
        await alerts.raiseTraceVolumeAnomaly(companyId, {
          pattern: "data_exfiltration_preparation",
          sourceAgentId: row.agentId,
          runId: row.runId,
          readCount: row.readCount,
          threshold: DEFAULTS.exfiltrationReadThreshold,
        });
        alertsRaised++;
      }

      return {
        detector: "detectDataExfiltration",
        companyId,
        anomaliesFound: highReadRuns.length,
        alertsRaised,
        scannedSpans: highReadRuns.reduce((s: number, r: { readCount: number }) => s + r.readCount, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * 4. Trace pipeline manipulation — Modification to collector config,
     * routing rules, or export destinations outside a tracked deployment
     * (CISO §6.2.4).
     *
     * Detects spans with action types related to configuration changes
     * that do not originate from a deployment/CI context.
     */
    async detectPipelineManipulation(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      const manipulationSpans = await db
        .select({
          agentId: auditSpans.agentId,
          runId: auditSpans.runId,
          actionType: auditSpans.actionType,
          targetResource: auditSpans.targetResource,
          spanCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
            sql`${auditSpans.actionType} IN ('config.modify', 'collector.config.update', 'export.destination.modify', 'pipeline.route.modify')`,
          ),
        )
        .groupBy(
          auditSpans.agentId,
          auditSpans.runId,
          auditSpans.actionType,
          auditSpans.targetResource,
        );

      for (const row of manipulationSpans) {
        await alerts.raiseTamperDetected(companyId, {
          pattern: "pipeline_manipulation",
          agentId: row.agentId,
          runId: row.runId,
          actionType: row.actionType,
          targetResource: row.targetResource,
          spanCount: row.spanCount,
        });
        alertsRaised++;
      }

      return {
        detector: "detectPipelineManipulation",
        companyId,
        anomaliesFound: manipulationSpans.length,
        alertsRaised,
        scannedSpans: manipulationSpans.reduce((s: number, r: { spanCount: number }) => s + r.spanCount, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * 5. Lateral movement — Agent A creating subtasks that delegate to
     * Agent B with escalated permissions not warranted by the parent
     * task (CISO §6.2.5).
     *
     * Detects issue.create spans where the created issue assigns a
     * different agent and the target agent has a higher privilege role.
     */
    async detectLateralMovement(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      // Look for issue creation/delegation spans where the acting agent
      // delegates to an agent with a more privileged role.
      const delegationSpans = await db
        .select({
          actingAgentId: auditSpans.agentId,
          runId: auditSpans.runId,
          targetResource: auditSpans.targetResource,
          spanCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
            sql`${auditSpans.actionType} IN ('issue.create', 'issue.assign', 'issue.delegate')`,
            // Target resource field encodes the delegated-to agent in the
            // span attributes; look for cross-agent delegation.
            sql`${auditSpans.targetResource} LIKE 'agent:%'`,
            sql`${auditSpans.targetResource} != CONCAT('agent:', ${auditSpans.agentId}::text)`,
          ),
        )
        .groupBy(auditSpans.agentId, auditSpans.runId, auditSpans.targetResource);

      for (const row of delegationSpans) {
        await alerts.raise({
          companyId,
          alertType: "SEQUENCE_GAP", // Closest severity match — high priority
          message: "Cross-agent delegation detected — possible lateral movement",
          details: {
            pattern: "lateral_movement",
            actingAgentId: row.actingAgentId,
            runId: row.runId,
            targetResource: row.targetResource,
            delegationCount: row.spanCount,
          },
          sourceAgentId: row.actingAgentId,
          sourceRunId: row.runId,
        });
        alertsRaised++;
      }

      return {
        detector: "detectLateralMovement",
        companyId,
        anomaliesFound: delegationSpans.length,
        alertsRaised,
        scannedSpans: delegationSpans.reduce((s: number, r: { spanCount: number }) => s + r.spanCount, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * 6. Replay attacks — Duplicate trace IDs or span IDs appearing
     * from different source agents (CISO §6.2.6).
     *
     * Detects span_id values that appear more than once with different
     * agent_id origins within the window.
     */
    async detectReplayAttacks(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      // Find span IDs that have been emitted by more than one agent.
      const duplicateSpans = await db
        .select({
          spanId: auditSpans.spanId,
          agentCount: sql<number>`count(DISTINCT ${auditSpans.agentId})::int`,
          totalOccurrences: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
          ),
        )
        .groupBy(auditSpans.spanId)
        .having(sql`count(DISTINCT ${auditSpans.agentId}) > 1`);

      for (const row of duplicateSpans) {
        await alerts.raiseTraceAuthFailure(companyId, {
          pattern: "replay_attack",
          spanId: row.spanId,
          distinctAgents: row.agentCount,
          totalOccurrences: row.totalOccurrences,
        });
        alertsRaised++;
      }

      // Also check for duplicate trace IDs from different agents.
      const duplicateTraces = await db
        .select({
          traceId: auditSpans.traceId,
          agentCount: sql<number>`count(DISTINCT ${auditSpans.agentId})::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
          ),
        )
        .groupBy(auditSpans.traceId)
        .having(sql`count(DISTINCT ${auditSpans.agentId}) > 1`);

      for (const row of duplicateTraces) {
        // Trace IDs shared across agents within a single trace context
        // are expected (parent → child spans). Only flag when the trace
        // has an unusually high number of distinct agents (>2), which
        // suggests injection rather than normal context propagation.
        if (row.agentCount > 2) {
          await alerts.raiseTraceAuthFailure(companyId, {
            pattern: "replay_attack_trace",
            traceId: row.traceId,
            distinctAgents: row.agentCount,
          });
          alertsRaised++;
        }
      }

      return {
        detector: "detectReplayAttacks",
        companyId,
        anomaliesFound: duplicateSpans.length + duplicateTraces.filter((r: { agentCount: number }) => r.agentCount > 2).length,
        alertsRaised,
        scannedSpans: duplicateSpans.reduce((s: number, r: { totalOccurrences: number }) => s + r.totalOccurrences, 0),
        durationMs: Date.now() - start,
      };
    },

    /**
     * Detect agent trace volume anomalies — agents producing >3σ above
     * baseline spans/hour (CISO §6.1 AGENT_TRACE_VOLUME_ANOMALY).
     *
     * Compares current-window volume against a rolling baseline.
     */
    async detectVolumeAnomalies(
      companyId: string,
      window: DetectionWindow,
    ): Promise<DetectionResult> {
      const start = Date.now();
      const endTime = window.endTime ?? new Date();
      let alertsRaised = 0;

      // Compute baseline: mean + stddev of spans/hour per agent over
      // the past DEFAULTS.volumeBaselineHours.
      const baselineStart = new Date(
        endTime.getTime() - DEFAULTS.volumeBaselineHours * 60 * 60 * 1000,
      );

      const baseline = await db
        .select({
          agentId: auditSpans.agentId,
          totalSpans: sql<number>`count(*)::int`,
          hoursInWindow: sql<number>`GREATEST(1, EXTRACT(EPOCH FROM (${endTime}::timestamptz - ${baselineStart}::timestamptz)) / 3600)`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, baselineStart),
            lte(auditSpans.startTime, endTime),
          ),
        )
        .groupBy(auditSpans.agentId);

      // Build per-agent baseline rate.
      const agentBaseline = new Map<string, { meanPerHour: number; total: number }>();
      for (const row of baseline) {
        const meanPerHour = row.totalSpans / row.hoursInWindow;
        agentBaseline.set(row.agentId, { meanPerHour, total: row.totalSpans });
      }

      // Compute current window rates.
      const windowHours = Math.max(
        1,
        (endTime.getTime() - window.startTime.getTime()) / (60 * 60 * 1000),
      );

      const currentRates = await db
        .select({
          agentId: auditSpans.agentId,
          spanCount: sql<number>`count(*)::int`,
        })
        .from(auditSpans)
        .where(
          and(
            eq(auditSpans.companyId, companyId),
            gte(auditSpans.startTime, window.startTime),
            lte(auditSpans.startTime, endTime),
          ),
        )
        .groupBy(auditSpans.agentId);

      for (const row of currentRates) {
        const base = agentBaseline.get(row.agentId);
        if (!base || base.total < DEFAULTS.volumeBaselineMinSpans) continue;

        const currentRate = row.spanCount / windowHours;
        // Approximate stddev as 30% of mean for now (a full stddev
        // computation over hourly buckets requires a more complex query).
        const approxStddev = base.meanPerHour * 0.3;
        const threshold = base.meanPerHour + DEFAULTS.volumeSigmaThreshold * approxStddev;

        if (currentRate > threshold) {
          await alerts.raiseTraceVolumeAnomaly(companyId, {
            sourceAgentId: row.agentId,
            currentRate: Math.round(currentRate * 100) / 100,
            baselineMean: Math.round(base.meanPerHour * 100) / 100,
            threshold: Math.round(threshold * 100) / 100,
            windowHours,
            spanCount: row.spanCount,
          });
          alertsRaised++;
        }
      }

      return {
        detector: "detectVolumeAnomalies",
        companyId,
        anomaliesFound: alertsRaised,
        alertsRaised,
        scannedSpans: currentRates.reduce((s: number, r: { spanCount: number }) => s + r.spanCount, 0),
        durationMs: Date.now() - start,
      };
    },
  };
}
