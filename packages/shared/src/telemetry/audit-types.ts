/**
 * Audit trail type definitions for OpenTelemetry-based structured tracing.
 *
 * Per CLO Compliance Requirements (PAX-115 §1-§2) and CISO Security Requirements (PAX-115 §2).
 */

/**
 * Structured action types for audit trail spans (CLO §2 — must be enum, not free text).
 */
export type AuditActionType =
  // Status transitions
  | "issue.status_transition"
  | "issue.checkout"
  | "issue.release"
  | "issue.create"
  | "issue.update"
  | "issue.comment"
  // Data access
  | "data.file_read"
  | "data.api_fetch"
  | "data.db_query"
  // Data mutations
  | "data.file_write"
  | "data.issue_update"
  | "data.comment_post"
  // Tool invocations
  | "tool.bash_command"
  | "tool.code_edit"
  | "tool.web_fetch"
  | "tool.agent_invoke"
  // Authentication events
  | "auth.token_issued"
  | "auth.api_key_used"
  | "auth.checkout"
  | "auth.session_start"
  | "auth.session_end"
  // Delegation actions
  | "delegation.subtask_create"
  | "delegation.reassign"
  | "delegation.mention"
  // External communications
  | "comms.signal_message"
  | "comms.webhook_fire"
  | "comms.external_api_call"
  // Heartbeat lifecycle
  | "heartbeat.start"
  | "heartbeat.execute"
  | "heartbeat.complete"
  | "heartbeat.adapter_invoke"
  | "heartbeat.session_setup"
  | "heartbeat.workspace_setup"
  | "heartbeat.cost_report"
  | "heartbeat.log_persist"
  // FAA-enhanced (CLO §9)
  | "faa.flight_cost_calculation"
  | "faa.passenger_matching"
  | "faa.payment_processing"
  | "faa.cost_sharing_decision";

/**
 * Outcome values for audit spans (CLO §2).
 */
export type AuditOutcome = "success" | "failure" | "denied" | "timeout";

/**
 * Required trace field keys per CLO §2.
 * Used as span attribute keys on every audit span.
 */
export const AUDIT_ATTR = {
  AGENT_ID: "pax.agent.id",
  ISSUE_ID: "pax.issue.id",
  RUN_ID: "pax.run.id",
  ACTION_TYPE: "pax.action.type",
  OUTCOME: "pax.outcome",
  TARGET_RESOURCE: "pax.target.resource",
  COMPANY_ID: "pax.company.id",
  ERROR_DETAIL: "pax.error.detail",
  SPAN_SIGNATURE: "pax.span.signature",
  SEQUENCE_NUMBER: "pax.sequence.number",
  ADAPTER_TYPE: "pax.adapter.type",
  SESSION_ID: "pax.session.id",
  ISSUE_IDENTIFIER: "pax.issue.identifier",
} as const;

/**
 * Configuration for the audit trail OTel integration.
 */
export interface AuditTrailConfig {
  /** Whether audit tracing is enabled */
  enabled: boolean;
  /** OTLP endpoint for trace export (e.g. "http://localhost:4317") */
  otlpEndpoint?: string;
  /** Whether to use gRPC (preferred) or HTTP for OTLP */
  otlpProtocol?: "grpc" | "http";
  /** Service name for the OTel resource */
  serviceName?: string;
  /** Deployment environment identifier */
  environment?: string;
  /** Whether span signing is enabled (Phase 2) */
  signingEnabled?: boolean;
  /** Whether Merkle integrity is enabled (Phase 3) */
  merkleEnabled?: boolean;
  /** Constant-rate batching interval in ms for traffic analysis resistance (CISO §4.3) */
  batchIntervalMs?: number;
}

/**
 * Audit trail storage tiers per CLO §3.
 */
export type AuditStorageTier = "hot" | "cold" | "legal_hold";

/**
 * Alert severity levels per CISO §6.1.
 */
export type AuditAlertSeverity = "critical" | "high" | "medium" | "low";

/**
 * Alert IDs per CISO §6.1.
 */
export type AuditAlertId =
  | "TAMPER_DETECTED"
  | "TRACE_AUTH_FAILURE"
  | "SEQUENCE_GAP"
  | "EXCESSIVE_QUERY"
  | "EXPORT_ANOMALY"
  | "COLLECTOR_DOWN"
  | "CLOCK_SKEW"
  | "AGENT_TRACE_VOLUME_ANOMALY"
  | "CROSS_TENANT_ATTEMPT"
  | "KEY_ROTATION_OVERDUE";

/**
 * Patterns of string keys that MUST NOT appear in trace attributes (CLO §2 prohibited fields).
 */
export const PROHIBITED_ATTRIBUTE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /PAPERCLIP_API_KEY/,
  /PAPERCLIP_AGENT_JWT_SECRET/,
  /BETTER_AUTH_SECRET/,
] as const;

/**
 * Check if a key matches any prohibited attribute pattern.
 */
export function isProhibitedAttribute(key: string): boolean {
  return PROHIBITED_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(key));
}
