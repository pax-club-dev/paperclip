export { TelemetryClient } from "./client.js";
export { resolveTelemetryConfig } from "./config.js";
export { loadOrCreateState } from "./state.js";
export {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
  trackProjectCreated,
  trackRoutineCreated,
  trackRoutineRun,
  trackGoalCreated,
  trackAgentCreated,
  trackSkillImported,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackErrorHandlerCrash,
} from "./events.js";
export type {
  TelemetryConfig,
  TelemetryState,
  TelemetryEvent,
  TelemetryEventEnvelope,
  TelemetryEventName,
} from "./types.js";

// ---- Audit trail (OpenTelemetry) ----
export {
  initAuditTracing,
  getAuditTracer,
  getAuditOTelApi,
  isAuditTracingEnabled,
  shutdownAuditTracing,
  flushAuditTracing,
  resolveAuditTrailConfig,
} from "./otel-tracing.js";
export type { AuditTracingInitOptions } from "./otel-tracing.js";

// ---- Span signing (Phase 2) ----
export {
  SigningSpanProcessor,
  buildCanonicalPayload,
  hrTimeToNanosString,
  CANONICAL_FIELD_ORDER,
} from "./signing-span-processor.js";
export type { SpanSignFn } from "./signing-span-processor.js";
export {
  AUDIT_ATTR,
  isProhibitedAttribute,
  PROHIBITED_ATTRIBUTE_PATTERNS,
} from "./audit-types.js";
export type {
  AuditActionType,
  AuditOutcome,
  AuditTrailConfig,
  AuditStorageTier,
  AuditAlertSeverity,
  AuditAlertId,
} from "./audit-types.js";

// ---- FAA trace enrichment (Phase 9, CLO §9) ----
export {
  FAA_RETENTION_DAYS,
  FAA_ATTR,
  FAA_ACTION_TYPES,
  enrichFlightCostCalculation,
  enrichPassengerMatching,
  enrichPaymentProcessing,
  enrichCostSharingDecision,
  isFaaRegulatedAction,
} from "./faa-trace-enrichment.js";
export type {
  FlightCostInput,
  FlightCostOutput,
  PassengerMatchInput,
  PassengerMatchOutput,
  PaymentInput,
  PaymentOutput,
  CostSharingDecisionInput,
  CostSharingDecisionOutput,
} from "./faa-trace-enrichment.js";
