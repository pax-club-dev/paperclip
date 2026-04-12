/**
 * Trace signature verification utility.
 *
 * Per CISO §2.1: Unsigned/invalid spans rejected with TRACE_AUTH_FAILURE alert.
 * Used by the OTel collector receiver and the trace query layer.
 */

import { verify, createPublicKey, type KeyObject } from "node:crypto";
import {
  buildCanonicalPayload,
  hrTimeToNanosString,
} from "@paperclipai/shared/telemetry/signing-span-processor.js";
import { AUDIT_ATTR } from "@paperclipai/shared/telemetry/audit-types.js";

/** Fields extracted from a span for verification. */
export interface SpanVerificationInput {
  traceId: string;
  spanId: string;
  agentId: string;
  runId: string;
  /** OTel HrTime [seconds, nanoseconds]. */
  startTime: [number, number];
  actionType: string;
  targetResource: string;
  outcome: string;
  /** Base64-encoded Ed25519 signature. */
  signature: string;
}

/** Result of span signature verification. */
export interface VerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify a span's Ed25519 signature against its canonical fields.
 *
 * @param input — The span fields and signature to verify.
 * @param publicKey — Ed25519 public key (PEM string or KeyObject).
 */
export function verifySpanSignature(
  input: SpanVerificationInput,
  publicKey: string | KeyObject,
): VerificationResult {
  try {
    const key =
      typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;

    const payload = buildCanonicalPayload(
      input.traceId,
      input.spanId,
      input.agentId,
      input.runId,
      hrTimeToNanosString(input.startTime),
      input.actionType,
      input.targetResource,
      input.outcome,
    );

    const signatureBuffer = Buffer.from(input.signature, "base64");
    const valid = verify(null, payload, key, signatureBuffer);

    return { valid };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Batch-verify multiple span signatures.
 * Returns results in the same order as inputs.
 */
export function verifySpanSignatureBatch(
  inputs: SpanVerificationInput[],
  publicKey: string | KeyObject,
): VerificationResult[] {
  const key =
    typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  return inputs.map((input) => verifySpanSignature(input, key));
}

/**
 * Extract verification input from raw span data.
 * Returns null if the span lacks a signature or required fields.
 */
export function extractVerificationInput(
  traceId: string,
  spanId: string,
  startTime: [number, number],
  attributes: Record<string, unknown>,
): SpanVerificationInput | null {
  const signature = attributes[AUDIT_ATTR.SPAN_SIGNATURE];
  if (typeof signature !== "string" || !signature) return null;

  const runId = attributes[AUDIT_ATTR.RUN_ID];
  if (typeof runId !== "string") return null;

  return {
    traceId,
    spanId,
    agentId: (attributes[AUDIT_ATTR.AGENT_ID] as string) ?? "",
    runId,
    startTime,
    actionType: (attributes[AUDIT_ATTR.ACTION_TYPE] as string) ?? "",
    targetResource: (attributes[AUDIT_ATTR.TARGET_RESOURCE] as string) ?? "",
    outcome: (attributes[AUDIT_ATTR.OUTCOME] as string) ?? "",
    signature,
  };
}
