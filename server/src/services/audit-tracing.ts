/**
 * Audit tracing service — instruments the heartbeat execution pipeline with
 * OpenTelemetry spans per CLO §1-§2 and CISO §2 requirements.
 *
 * This module provides helper functions that wrap key execution phases in spans
 * with the required audit attributes. It is designed to be called from the
 * heartbeat service without tightly coupling the two.
 *
 * Usage in heartbeat.ts:
 *   import { auditTracing } from "./audit-tracing.js";
 *   const audit = auditTracing();
 *   await audit.traceHeartbeatRun({ runId, agentId, companyId, issueId }, async (span) => {
 *     // ... existing executeRun logic ...
 *   });
 */

import {
  getAuditTracer,
  getAuditOTelApi,
  isAuditTracingEnabled,
} from "@paperclipai/shared/telemetry/otel-tracing.js";
import {
  AUDIT_ATTR,
  isProhibitedAttribute,
  type AuditActionType,
  type AuditOutcome,
} from "@paperclipai/shared/telemetry/audit-types.js";
import {
  FAA_RETENTION_DAYS,
  isFaaRegulatedAction,
  enrichFlightCostCalculation,
  enrichPassengerMatching,
  enrichPaymentProcessing,
  enrichCostSharingDecision,
  type FlightCostInput,
  type FlightCostOutput,
  type PassengerMatchInput,
  type PassengerMatchOutput,
  type PaymentInput,
  type PaymentOutput,
  type CostSharingDecisionInput,
  type CostSharingDecisionOutput,
} from "@paperclipai/shared/telemetry/faa-trace-enrichment.js";

type Span = import("@opentelemetry/api").Span;
type SpanStatusCode = import("@opentelemetry/api").SpanStatusCode;

/** Context fields available for every heartbeat run. */
export interface HeartbeatRunContext {
  runId: string;
  agentId: string;
  companyId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  adapterType?: string;
}

/** Per-run sequence counter for CISO §2.3 monotonic sequence integrity. */
const runSequenceCounters = new Map<string, number>();

function nextSequenceNumber(runId: string): number {
  const current = runSequenceCounters.get(runId) ?? 0;
  const next = current + 1;
  runSequenceCounters.set(runId, next);
  return next;
}

function clearSequenceCounter(runId: string): void {
  runSequenceCounters.delete(runId);
}

/**
 * Sanitize attributes to strip prohibited fields (CLO §2 prohibited fields).
 * Replaces secret values with "[REDACTED]".
 */
function sanitizeAttributes(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (isProhibitedAttribute(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Set standard audit attributes on a span.
 */
function setAuditAttributes(
  span: Span,
  ctx: HeartbeatRunContext,
  actionType: AuditActionType,
  extra?: Record<string, string | number | boolean | undefined>,
): void {
  const baseAttrs: Record<string, string | number | boolean | undefined> = {
    [AUDIT_ATTR.AGENT_ID]: ctx.agentId,
    [AUDIT_ATTR.RUN_ID]: ctx.runId,
    [AUDIT_ATTR.COMPANY_ID]: ctx.companyId,
    [AUDIT_ATTR.ACTION_TYPE]: actionType,
    [AUDIT_ATTR.SEQUENCE_NUMBER]: nextSequenceNumber(ctx.runId),
  };

  if (ctx.issueId) {
    baseAttrs[AUDIT_ATTR.ISSUE_ID] = ctx.issueId;
  }
  if (ctx.issueIdentifier) {
    baseAttrs[AUDIT_ATTR.ISSUE_IDENTIFIER] = ctx.issueIdentifier;
  }
  if (ctx.adapterType) {
    baseAttrs[AUDIT_ATTR.ADAPTER_TYPE] = ctx.adapterType;
  }

  const merged = extra ? { ...baseAttrs, ...extra } : baseAttrs;
  span.setAttributes(sanitizeAttributes(merged));
}

/**
 * Set the outcome attribute on a span and update its status.
 */
function setOutcome(span: Span, outcome: AuditOutcome, errorDetail?: string): void {
  span.setAttribute(AUDIT_ATTR.OUTCOME, outcome);
  if (errorDetail) {
    span.setAttribute(AUDIT_ATTR.ERROR_DETAIL, errorDetail);
  }

  const api = getAuditOTelApi();
  if (api) {
    if (outcome === "failure" || outcome === "denied") {
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: errorDetail });
    } else {
      span.setStatus({ code: api.SpanStatusCode.OK });
    }
  }
}

export function auditTracing() {
  const tracer = getAuditTracer();
  const enabled = isAuditTracingEnabled();

  return {
    /** Whether audit tracing is active. */
    enabled,

    /**
     * Wrap the entire heartbeat run execution in a root span.
     *
     * CLO §1: Every agent action that modifies state must produce a trace.
     * CLO §2: All required fields set as span attributes.
     */
    async traceHeartbeatRun<T>(
      ctx: HeartbeatRunContext,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan(
        "heartbeat.run",
        { attributes: sanitizeAttributes({ [AUDIT_ATTR.ACTION_TYPE]: "heartbeat.start" }) },
        async (span) => {
          setAuditAttributes(span, ctx, "heartbeat.start");
          try {
            const result = await fn(span);
            setOutcome(span, "success");
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setOutcome(span, "failure", message);
            span.recordException(err instanceof Error ? err : new Error(message));
            throw err;
          } finally {
            clearSequenceCounter(ctx.runId);
            span.end();
          }
        },
      );
    },

    /**
     * Trace the adapter execution phase.
     */
    async traceAdapterExecution<T>(
      ctx: HeartbeatRunContext,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan("heartbeat.adapter_invoke", async (span) => {
        setAuditAttributes(span, ctx, "heartbeat.adapter_invoke", {
          [AUDIT_ATTR.TARGET_RESOURCE]: ctx.adapterType ?? "unknown",
        });
        try {
          const result = await fn(span);
          setOutcome(span, "success");
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          span.recordException(err instanceof Error ? err : new Error(message));
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Trace workspace setup/resolution.
     */
    async traceWorkspaceSetup<T>(
      ctx: HeartbeatRunContext,
      workspaceSource: string,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan("heartbeat.workspace_setup", async (span) => {
        setAuditAttributes(span, ctx, "heartbeat.workspace_setup", {
          [AUDIT_ATTR.TARGET_RESOURCE]: workspaceSource,
        });
        try {
          const result = await fn(span);
          setOutcome(span, "success");
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Trace session setup/resolution.
     */
    async traceSessionSetup<T>(
      ctx: HeartbeatRunContext & { sessionId?: string | null },
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan("heartbeat.session_setup", async (span) => {
        setAuditAttributes(span, ctx, "heartbeat.session_setup", {
          [AUDIT_ATTR.SESSION_ID]: ctx.sessionId ?? undefined,
        });
        try {
          const result = await fn(span);
          setOutcome(span, "success");
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Trace cost reporting.
     */
    async traceCostReport<T>(
      ctx: HeartbeatRunContext,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan("heartbeat.cost_report", async (span) => {
        setAuditAttributes(span, ctx, "heartbeat.cost_report");
        try {
          const result = await fn(span);
          setOutcome(span, "success");
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Trace log persistence.
     */
    async traceLogPersist<T>(
      ctx: HeartbeatRunContext,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      if (!enabled) return fn(noopSpan());

      return tracer.startActiveSpan("heartbeat.log_persist", async (span) => {
        setAuditAttributes(span, ctx, "heartbeat.log_persist");
        try {
          const result = await fn(span);
          setOutcome(span, "success");
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Record a discrete audit event as a span (for non-wrapper use cases).
     *
     * Use this for one-shot events like auth token issuance, issue checkout, etc.
     */
    recordEvent(
      ctx: HeartbeatRunContext,
      actionType: AuditActionType,
      outcome: AuditOutcome,
      extra?: Record<string, string | number | boolean | undefined>,
    ): void {
      if (!enabled) return;

      const span = tracer.startSpan(`audit.${actionType}`);
      setAuditAttributes(span, ctx, actionType, extra);
      setOutcome(span, outcome);
      span.end();
    },

    /**
     * Record an authentication event.
     */
    recordAuthEvent(
      ctx: HeartbeatRunContext,
      authAction: "auth.token_issued" | "auth.api_key_used" | "auth.checkout" | "auth.session_start" | "auth.session_end",
      outcome: AuditOutcome,
    ): void {
      if (!enabled) return;
      this.recordEvent(ctx, authAction, outcome);
    },

    // ── FAA-enhanced traces (CLO §9) ──────────────────────────

    /**
     * Trace a flight cost calculation with full input/output parameters.
     *
     * CLO §9: FAA-regulated spans require enhanced attributes and 3-year retention.
     * The retentionOverrideDays value is set on the span so that downstream
     * storage (audit_spans table) can apply the correct lifecycle.
     */
    async traceFlightCostCalculation<T>(
      ctx: HeartbeatRunContext,
      input: FlightCostInput,
      fn: (span: Span) => Promise<T>,
    ): Promise<{ result: T; output: FlightCostOutput | null }> {
      if (!enabled) {
        const result = await fn(noopSpan());
        return { result, output: null };
      }

      return tracer.startActiveSpan("faa.flight_cost_calculation", async (span) => {
        setAuditAttributes(span, ctx, "faa.flight_cost_calculation", {
          [AUDIT_ATTR.TARGET_RESOURCE]: `flight/${input.flightId}`,
        });
        try {
          const result = await fn(span);
          // Caller is expected to provide the output via the returned result.
          // We enrich the span with whatever cost output data is available.
          const output: FlightCostOutput = (result as { costOutput?: FlightCostOutput })?.costOutput ?? {
            totalCostCents: 0,
            perSeatCostCents: 0,
            currency: "USD",
          };
          span.setAttributes(enrichFlightCostCalculation(input, output));
          setOutcome(span, "success");
          return { result, output };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setOutcome(span, "failure", message);
          span.recordException(err instanceof Error ? err : new Error(message));
          throw err;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Record a flight cost calculation as a discrete event span.
     */
    recordFlightCostCalculation(
      ctx: HeartbeatRunContext,
      input: FlightCostInput,
      output: FlightCostOutput,
      outcome: AuditOutcome,
    ): void {
      if (!enabled) return;

      const span = tracer.startSpan("faa.flight_cost_calculation");
      setAuditAttributes(span, ctx, "faa.flight_cost_calculation", {
        [AUDIT_ATTR.TARGET_RESOURCE]: `flight/${input.flightId}`,
      });
      span.setAttributes(enrichFlightCostCalculation(input, output));
      setOutcome(span, outcome);
      span.end();
    },

    /**
     * Record a passenger matching event with full parameters.
     */
    recordPassengerMatching(
      ctx: HeartbeatRunContext,
      input: PassengerMatchInput,
      output: PassengerMatchOutput,
      outcome: AuditOutcome,
    ): void {
      if (!enabled) return;

      const span = tracer.startSpan("faa.passenger_matching");
      setAuditAttributes(span, ctx, "faa.passenger_matching", {
        [AUDIT_ATTR.TARGET_RESOURCE]: `passengers/${input.passengerHashList.length}`,
      });
      span.setAttributes(enrichPassengerMatching(input, output));
      setOutcome(span, outcome);
      span.end();
    },

    /**
     * Record a payment processing event with full parameters.
     */
    recordPaymentProcessing(
      ctx: HeartbeatRunContext,
      input: PaymentInput,
      output: PaymentOutput,
      outcome: AuditOutcome,
    ): void {
      if (!enabled) return;

      const span = tracer.startSpan("faa.payment_processing");
      setAuditAttributes(span, ctx, "faa.payment_processing", {
        [AUDIT_ATTR.TARGET_RESOURCE]: `payment/${input.paymentId}`,
      });
      span.setAttributes(enrichPaymentProcessing(input, output));
      setOutcome(span, outcome);
      span.end();
    },

    /**
     * Record a cost-sharing decision event with full parameters.
     */
    recordCostSharingDecision(
      ctx: HeartbeatRunContext,
      input: CostSharingDecisionInput,
      output: CostSharingDecisionOutput,
      outcome: AuditOutcome,
    ): void {
      if (!enabled) return;

      const span = tracer.startSpan("faa.cost_sharing_decision");
      setAuditAttributes(span, ctx, "faa.cost_sharing_decision", {
        [AUDIT_ATTR.TARGET_RESOURCE]: `decision/${input.decisionId}`,
      });
      span.setAttributes(enrichCostSharingDecision(input, output));
      setOutcome(span, outcome);
      span.end();
    },

    /**
     * Check if an action type requires FAA 3-year retention.
     */
    isFaaRegulated: isFaaRegulatedAction,

    /**
     * FAA retention period in days.
     */
    faaRetentionDays: FAA_RETENTION_DAYS,
  };
}

// Internal no-op span for when tracing is disabled.
function noopSpan(): Span {
  return {
    spanContext: () => ({
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    }),
    setAttribute: () => noopSpan(),
    setAttributes: () => noopSpan(),
    addEvent: () => noopSpan(),
    addLink: () => noopSpan(),
    setStatus: () => noopSpan(),
    updateName: () => noopSpan(),
    end: () => {},
    isRecording: () => false,
    recordException: () => {},
  } as unknown as Span;
}
