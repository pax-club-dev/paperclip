/**
 * SigningSpanProcessor — signs each audit span with Ed25519 before export.
 *
 * Per CISO §2.1: Per-span cryptographic signing for trace authenticity.
 *
 * This processor must be registered BEFORE the BatchSpanProcessor in the
 * provider's processor chain. It extracts canonical fields from each ended
 * span, signs them via a callback, and attaches the signature as a span
 * attribute before downstream processors queue the span for export.
 */

import type { Context } from "@opentelemetry/api";
import type {
  SpanProcessor,
  ReadableSpan,
  Span,
} from "@opentelemetry/sdk-trace-base";
import { AUDIT_ATTR } from "./audit-types.js";

/**
 * Canonical field order for span signing (CISO §2.1).
 * Fields are concatenated with | delimiter in this exact order.
 */
export const CANONICAL_FIELD_ORDER = [
  "trace_id",
  "span_id",
  "agent_id",
  "run_id",
  "timestamp",
  "action_type",
  "target_resource",
  "outcome",
] as const;

/**
 * Build the canonical byte payload for signing.
 *
 * Fields are joined with | in a fixed order. Empty/missing fields are
 * represented as empty strings. This ensures deterministic signature generation.
 */
export function buildCanonicalPayload(
  traceId: string,
  spanId: string,
  agentId: string,
  runId: string,
  timestampNs: string,
  actionType: string,
  targetResource: string,
  outcome: string,
): Buffer {
  const canonical = [
    traceId,
    spanId,
    agentId,
    runId,
    timestampNs,
    actionType,
    targetResource,
    outcome,
  ].join("|");
  return Buffer.from(canonical, "utf8");
}

/**
 * Convert OTel HrTime [seconds, nanoseconds] to a deterministic string.
 * Produces a fixed-format nanosecond timestamp for canonical payload construction.
 */
export function hrTimeToNanosString(hrTime: [number, number]): string {
  const [seconds, nanos] = hrTime;
  return `${seconds}${String(nanos).padStart(9, "0")}`;
}

/**
 * Signing function type. Takes a run ID and canonical payload buffer,
 * returns the base64-encoded Ed25519 signature, or null if unavailable.
 */
export type SpanSignFn = (runId: string, payload: Buffer) => string | null;

/**
 * SpanProcessor that signs each span with Ed25519 before export.
 *
 * Registration order matters: this processor must come before the
 * BatchSpanProcessor in the spanProcessors array so that signatures
 * are attached before spans are queued for OTLP export.
 */
export class SigningSpanProcessor implements SpanProcessor {
  private readonly signFn: SpanSignFn;

  constructor(signFn: SpanSignFn) {
    this.signFn = signFn;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No action on start — signing happens in onEnd when all attributes are final.
  }

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes;

    // Only sign spans that carry a run_id (audit spans).
    const runId = attrs[AUDIT_ATTR.RUN_ID];
    if (typeof runId !== "string" || !runId) return;

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    const agentId = (attrs[AUDIT_ATTR.AGENT_ID] as string) ?? "";
    const timestampNs = hrTimeToNanosString(span.startTime as [number, number]);
    const actionType = (attrs[AUDIT_ATTR.ACTION_TYPE] as string) ?? "";
    const targetResource = (attrs[AUDIT_ATTR.TARGET_RESOURCE] as string) ?? "";
    const outcome = (attrs[AUDIT_ATTR.OUTCOME] as string) ?? "";

    const payload = buildCanonicalPayload(
      traceId,
      spanId,
      agentId,
      runId,
      timestampNs,
      actionType,
      targetResource,
      outcome,
    );

    const signature = this.signFn(runId, payload);
    if (signature) {
      // Direct attribute mutation on the span's attributes object.
      // This is intentional: the same object reference is shared with
      // downstream processors (BatchSpanProcessor) in the chain.
      (attrs as Record<string, unknown>)[AUDIT_ATTR.SPAN_SIGNATURE] = signature;
    }
  }

  async forceFlush(): Promise<void> {
    // No internal buffering — nothing to flush.
  }

  async shutdown(): Promise<void> {
    // No resources to release.
  }
}
