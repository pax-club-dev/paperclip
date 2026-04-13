export const PLUGIN_ID = "signal-bridge";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  signalIngest: "signal-ingest",
  signalSend: "signal-send",
} as const;

export const JOB_KEYS = {
  slaBreachCheck: "sla-breach-check",
  staleSessionCleanup: "stale-session-cleanup",
} as const;

/** Seconds before COO fast-ack fires. */
export const FAST_ACK_DEADLINE_MS = 15_000;
/** Seconds before a breach is logged. */
export const BREACH_DEADLINE_MS = 20_000;

/** Plugin state namespace for SLA tracking. */
export const SLA_NAMESPACE = "sla";
/** State key prefix for pending messages awaiting response. */
export const PENDING_MSG_PREFIX = "pending-msg-";
/** State key for the structured breach log (append-only array). */
export const BREACH_LOG_KEY = "breach-log";
/** Maximum breach log entries kept in state. */
export const MAX_BREACH_LOG_ENTRIES = 500;

/**
 * Path to the shared breach log file on disk.
 * The watchdog tails this file independently of the plugin.
 * Each line is a JSON-serialized BreachLogEntry.
 */
export const BREACH_LOG_FILE_PATH = "/tmp/paperclip-signal-sla-breaches.jsonl";

/** Plugin state namespace for inbox notification -> issue mapping. */
export const INBOX_NOTIFICATION_NAMESPACE = "signal-inbox";
/** State key prefix for Signal message timestamp -> issue ID mapping. */
export const INBOX_MSG_PREFIX = "msg-";

/** Founder-request issue labels that should trigger proactive outbound Signal notifications. */
export const FOUNDER_REQUEST_LABEL_NAMES = ["founder-request", "founder_request"] as const;

/** Plugin state namespace for persisted message history. */
export const MESSAGE_LOG_NAMESPACE = "message-log";
/** State key prefix for persisted messages. */
export const MESSAGE_LOG_PREFIX = "msg-";

/** Plugin state namespace for outbound signal-send rate limits. */
export const OUTBOUND_RATE_LIMIT_NAMESPACE = "signal-send-rate-limit";
/** Default per-agent proactive send quota (messages/minute). */
export const DEFAULT_OUTBOUND_PER_AGENT_PER_MINUTE_LIMIT = 5;
