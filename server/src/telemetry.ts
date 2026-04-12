import path from "node:path";
import {
  TelemetryClient,
  resolveTelemetryConfig,
  loadOrCreateState,
  resolveAuditTrailConfig,
  initAuditTracing,
  shutdownAuditTracing,
  SigningSpanProcessor,
} from "@paperclipai/shared/telemetry";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";
import { serverVersion } from "./version.js";
import { getTraceSigningManager } from "./services/trace-signing.js";

let client: TelemetryClient | null = null;

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  if (client) return client;

  const config = resolveTelemetryConfig(fileConfig);
  if (!config.enabled) return null;

  const stateDir = path.join(resolvePaperclipInstanceRoot(), "telemetry");
  client = new TelemetryClient(
    config,
    () => loadOrCreateState(stateDir, serverVersion),
    serverVersion,
  );
  client.startPeriodicFlush(60_000);
  return client;
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}

/**
 * Initialize the OpenTelemetry audit trail tracing system.
 * Called during server startup if PAPERCLIP_AUDIT_TRAIL_ENABLED is set.
 *
 * When signingEnabled is true and PAPERCLIP_TRACE_SIGNING_SALT is configured,
 * a SigningSpanProcessor is registered to Ed25519-sign each span before export.
 */
export async function initAuditTelemetry(): Promise<void> {
  const config = resolveAuditTrailConfig();
  if (!config.enabled) return;

  const preProcessors: unknown[] = [];

  if (config.signingEnabled) {
    const signingManager = getTraceSigningManager();
    if (signingManager) {
      preProcessors.push(
        new SigningSpanProcessor((runId, payload) =>
          signingManager.sign(runId, payload),
        ),
      );
    }
  }

  await initAuditTracing(config, { preProcessors });
}

/**
 * Gracefully shut down the audit trail tracing system.
 * Called during server shutdown to flush pending spans.
 */
export async function shutdownAuditTelemetry(): Promise<void> {
  await shutdownAuditTracing();
}
