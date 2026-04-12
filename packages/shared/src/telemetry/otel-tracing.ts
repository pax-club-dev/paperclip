/**
 * OpenTelemetry SDK initialization for the Paperclip audit trail.
 *
 * This module configures the TracerProvider, registers the OTLP exporter,
 * and provides the global tracer for audit span creation.
 *
 * Per CISO §4.1: OTLP/gRPC is the required transport protocol.
 * Per CISO §4.3: Constant-rate batching for traffic analysis resistance.
 *
 * Usage:
 *   import { initAuditTracing, getAuditTracer, shutdownAuditTracing } from "./otel-tracing.js";
 *   await initAuditTracing({ enabled: true, otlpEndpoint: "http://localhost:4317" });
 *   const tracer = getAuditTracer();
 *   const span = tracer.startSpan("heartbeat.execute");
 */

import type { AuditTrailConfig } from "./audit-types.js";

// ---- Lazy-loaded OTel types ----
// We import OTel modules lazily to avoid hard dependency when audit tracing is disabled.
// This keeps the runtime lean for installations that don't use the audit trail.

type OTelApi = typeof import("@opentelemetry/api");
type OTelTracer = import("@opentelemetry/api").Tracer;
type OTelTracerProvider = import("@opentelemetry/sdk-trace-node").NodeTracerProvider;
type OTelBatchSpanProcessor = import("@opentelemetry/sdk-trace-base").BatchSpanProcessor;

interface AuditTracingState {
  api: OTelApi;
  provider: OTelTracerProvider;
  processor: OTelBatchSpanProcessor;
  tracer: OTelTracer;
  config: AuditTrailConfig;
}

let state: AuditTracingState | null = null;

/** Service name used as the OTel resource attribute. */
const DEFAULT_SERVICE_NAME = "paperclip-server";

/** Tracer instrumentation scope name. */
const TRACER_NAME = "paperclip-audit-trail";

/**
 * Resolves audit trail configuration from environment variables and optional overrides.
 */
export function resolveAuditTrailConfig(overrides?: Partial<AuditTrailConfig>): AuditTrailConfig {
  const envEnabled = process.env.PAPERCLIP_AUDIT_TRAIL_ENABLED;
  const enabled = overrides?.enabled ?? (envEnabled === "true" || envEnabled === "1");

  return {
    enabled,
    otlpEndpoint:
      overrides?.otlpEndpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "http://localhost:4317",
    otlpProtocol:
      overrides?.otlpProtocol ??
      (process.env.OTEL_EXPORTER_OTLP_PROTOCOL === "http" ? "http" : "grpc"),
    serviceName:
      overrides?.serviceName ??
      process.env.OTEL_SERVICE_NAME ??
      DEFAULT_SERVICE_NAME,
    environment:
      overrides?.environment ??
      process.env.OTEL_RESOURCE_ATTRIBUTES_ENVIRONMENT ??
      process.env.NODE_ENV ??
      "development",
    signingEnabled:
      overrides?.signingEnabled ??
      (process.env.PAPERCLIP_AUDIT_SIGNING_ENABLED === "true" ||
        process.env.PAPERCLIP_AUDIT_SIGNING_ENABLED === "1"),
    merkleEnabled: overrides?.merkleEnabled ?? false,
    batchIntervalMs: overrides?.batchIntervalMs ?? 60_000, // CISO §4.3: constant-rate 60s
  };
}

/** Options for initAuditTracing beyond the config. */
export interface AuditTracingInitOptions {
  /**
   * SpanProcessors to register before the BatchSpanProcessor.
   * Use this for processors that need to mutate span attributes (e.g. signing)
   * before spans are queued for export.
   */
  preProcessors?: unknown[];
}

/**
 * Initialize the OpenTelemetry audit trail tracing system.
 *
 * Must be called once at server startup, before any spans are created.
 * If `config.enabled` is false, this is a no-op and `getAuditTracer()` returns a no-op tracer.
 */
export async function initAuditTracing(
  config: AuditTrailConfig,
  options?: AuditTracingInitOptions,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  if (state) {
    // Already initialized — idempotent.
    return;
  }

  // Dynamic imports — only loaded when audit tracing is enabled.
  const [api, { NodeTracerProvider }, { BatchSpanProcessor }, { Resource }, semconv] =
    await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

  // Build the appropriate exporter based on protocol.
  let exporter: import("@opentelemetry/sdk-trace-base").SpanExporter;
  if (config.otlpProtocol === "http") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    exporter = new OTLPTraceExporter({
      url: config.otlpEndpoint
        ? `${config.otlpEndpoint}/v1/traces`
        : undefined,
    });
  } else {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
    exporter = new OTLPTraceExporter({
      url: config.otlpEndpoint,
    });
  }

  const resource = new Resource({
    [semconv.ATTR_SERVICE_NAME]: config.serviceName ?? DEFAULT_SERVICE_NAME,
    [semconv.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    ["deployment.environment"]: config.environment ?? "development",
    ["service.instance.id"]: `${process.pid}`,
  });

  const processor = new BatchSpanProcessor(exporter, {
    // CISO §4.3: constant-rate batching — export at fixed cadence.
    scheduledDelayMillis: config.batchIntervalMs ?? 60_000,
    maxExportBatchSize: 1000,
    maxQueueSize: 4096,
  });

  // Pre-processors (e.g. SigningSpanProcessor) run before the batch processor
  // so they can mutate span attributes before export queuing.
  const preProcs = (options?.preProcessors ?? []) as import("@opentelemetry/sdk-trace-base").SpanProcessor[];
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [...preProcs, processor],
  });

  // Register as global provider so instrumentations can find it.
  provider.register();

  const tracer = api.trace.getTracer(TRACER_NAME, "1.0.0");

  state = {
    api,
    provider,
    processor,
    tracer,
    config,
  };
}

/**
 * Returns the audit trail tracer.
 *
 * If audit tracing is not initialized or disabled, returns the OTel no-op tracer
 * via a lazy dynamic import (or a minimal stub if OTel API is not available).
 */
export function getAuditTracer(): OTelTracer {
  if (state) {
    return state.tracer;
  }

  // Return a no-op tracer stub that satisfies the Tracer interface
  // without requiring the OTel API to be loaded.
  return noopTracer;
}

/**
 * Returns the OTel API module, or null if not initialized.
 */
export function getAuditOTelApi(): OTelApi | null {
  return state?.api ?? null;
}

/**
 * Returns whether audit tracing is active.
 */
export function isAuditTracingEnabled(): boolean {
  return state?.config.enabled === true;
}

/**
 * Gracefully shut down the audit tracing pipeline.
 * Flushes pending spans and releases resources.
 */
export async function shutdownAuditTracing(): Promise<void> {
  if (!state) return;

  try {
    await state.processor.forceFlush();
    await state.provider.shutdown();
  } finally {
    state = null;
  }
}

/**
 * Force-flush all pending audit spans without shutting down.
 */
export async function flushAuditTracing(): Promise<void> {
  if (!state) return;
  await state.processor.forceFlush();
}

// ---- No-op tracer stub ----
// Minimal implementation that matches the OTel Tracer interface shape
// without importing the full API package. Used when tracing is disabled.

const noopSpan = {
  spanContext: () => ({
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
    traceFlags: 0,
  }),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  addLink: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
} as unknown as import("@opentelemetry/api").Span;

const noopTracer: OTelTracer = {
  startSpan: () => noopSpan,
  startActiveSpan: ((_name: string, ...args: unknown[]) => {
    // The last argument is always the callback function.
    const fn = args[args.length - 1] as (span: typeof noopSpan) => unknown;
    return fn(noopSpan);
  }) as OTelTracer["startActiveSpan"],
};
