/**
 * SLA Watchdog — Independent service that tails the Signal bridge breach log
 * and files postmortem issues via the Paperclip REST API.
 *
 * This runs as a standalone process, independent of the Signal bridge plugin,
 * so it catches SLA breaches even if the plugin itself is down.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://127.0.0.1:3100 \
 *   PAPERCLIP_API_KEY=<token> \
 *   PAPERCLIP_COMPANY_ID=<uuid> \
 *   CTO_AGENT_ID=<uuid> \
 *   node dist/watchdog/sla-watchdog.js
 */

import { createReadStream, existsSync, watchFile, unwatchFile } from "node:fs";
import { stat, appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { BREACH_LOG_FILE_PATH } from "../constants.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const API_URL = process.env["PAPERCLIP_API_URL"];
const API_KEY = process.env["PAPERCLIP_API_KEY"];
const COMPANY_ID = process.env["PAPERCLIP_COMPANY_ID"];
const CTO_AGENT_ID = process.env["CTO_AGENT_ID"];
const POLL_INTERVAL_MS = Number(process.env["WATCHDOG_POLL_MS"] || "5000");
const DEDUP_FILE = "/tmp/paperclip-sla-watchdog-seen.jsonl";

/** Mask all but last 4 chars of a sender identifier (phone number). */
function maskSender(sender: string): string {
  if (!sender || sender.length <= 4) return sender ?? "unknown";
  return "***" + sender.slice(-4);
}

if (!API_URL || !API_KEY || !COMPANY_ID) {
  console.error(
    "Required env vars: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types (mirror of plugin's BreachLogEntry)
// ---------------------------------------------------------------------------

interface BreachLogEntry {
  messageId: string;
  sender: string;
  receivedAt: number;
  firstReplyAt: number | null;
  targetAgentId: string | null;
  latencyMs: number | null;
  breachDetectedAt: number;
  postmortemIssueId: string | null;
}

// ---------------------------------------------------------------------------
// Deduplication: track which breaches we already handled
// ---------------------------------------------------------------------------

const seenMessageIds = new Set<string>();

async function loadSeenIds(): Promise<void> {
  if (!existsSync(DEDUP_FILE)) return;
  const stream = createReadStream(DEDUP_FILE, "utf-8");
  const rl = createInterface({ input: stream });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) seenMessageIds.add(trimmed);
  }
}

async function markSeen(messageId: string): Promise<void> {
  seenMessageIds.add(messageId);
  await appendFile(DEDUP_FILE, messageId + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Paperclip API helpers
// ---------------------------------------------------------------------------

function apiRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const payload = body ? JSON.stringify(body) : undefined;

    const req = httpRequest(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch {
            resolve({ raw: data });
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createPostmortemIssue(entry: BreachLogEntry): Promise<void> {
  const title = `[Watchdog] SLA Breach: ${maskSender(entry.sender)} message unanswered >20s`;
  const description =
    `## SLA Breach — Watchdog Auto-Postmortem\n\n` +
    `**Source:** Independent SLA watchdog (not the Signal plugin)\n` +
    `**Message ID:** ${entry.messageId}\n` +
    `**Sender:** ${maskSender(entry.sender)}\n` +
    `**Received at:** ${new Date(entry.receivedAt).toISOString()}\n` +
    `**Target agent:** ${entry.targetAgentId ?? "none"}\n` +
    `**First reply at:** ${entry.firstReplyAt ? new Date(entry.firstReplyAt).toISOString() : "NONE"}\n` +
    `**Latency:** ${entry.latencyMs != null ? `${entry.latencyMs}ms` : "no response"}\n` +
    `**Breach detected at:** ${new Date(entry.breachDetectedAt).toISOString()}\n` +
    `**Plugin postmortem issue:** ${entry.postmortemIssueId ?? "none (plugin may be down)"}\n\n` +
    `## Root Cause Investigation\n\n` +
    `The watchdog detected this breach independently. If the plugin already filed a postmortem, ` +
    `this is a duplicate confirmation. If the plugin did NOT file one (postmortemIssueId is null), ` +
    `the plugin itself may have been down or crashed — investigate plugin health.\n\n` +
    `- Check plugin health status\n` +
    `- Check agent heartbeat logs\n` +
    `- Check server/process uptime\n`;

  const body: Record<string, unknown> = {
    title,
    description,
    status: "todo",
    priority: "critical",
  };
  if (CTO_AGENT_ID) {
    body["assigneeAgentId"] = CTO_AGENT_ID;
  }

  try {
    const result = await apiRequest(
      "POST",
      `/api/companies/${COMPANY_ID}/issues`,
      body,
    );
    console.log(
      `[watchdog] Filed postmortem issue for breach ${entry.messageId}: ${(result as Record<string, unknown>)["id"] ?? "unknown"}`,
    );
  } catch (err) {
    console.error(
      `[watchdog] Failed to file postmortem for ${entry.messageId}:`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Tail the breach log file
// ---------------------------------------------------------------------------

let lastOffset = 0;

async function processNewLines(): Promise<void> {
  if (!existsSync(BREACH_LOG_FILE_PATH)) return;

  const fileStat = await stat(BREACH_LOG_FILE_PATH);
  if (fileStat.size <= lastOffset) {
    // File was truncated or unchanged
    if (fileStat.size < lastOffset) lastOffset = 0;
    return;
  }

  const stream = createReadStream(BREACH_LOG_FILE_PATH, {
    start: lastOffset,
    encoding: "utf-8",
  });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as BreachLogEntry;
      if (seenMessageIds.has(entry.messageId)) continue;

      console.log(
        `[watchdog] New breach detected: ${entry.messageId} from ${maskSender(entry.sender)}`,
      );

      // If the plugin already filed a postmortem, just log and skip
      if (entry.postmortemIssueId) {
        console.log(
          `[watchdog] Plugin already filed postmortem ${entry.postmortemIssueId}, skipping duplicate.`,
        );
        await markSeen(entry.messageId);
        continue;
      }

      // Plugin didn't file — this means the plugin might be down. File our own.
      await createPostmortemIssue(entry);
      await markSeen(entry.messageId);
    } catch (err) {
      console.error("[watchdog] Failed to parse breach log line:", trimmed, err);
    }
  }

  lastOffset = fileStat.size;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[watchdog] SLA Watchdog starting");
  console.log(`[watchdog] Tailing: ${BREACH_LOG_FILE_PATH}`);
  console.log(`[watchdog] Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[watchdog] API: ${API_URL}`);
  console.log(`[watchdog] Company: ${COMPANY_ID}`);
  console.log(`[watchdog] CTO Agent: ${CTO_AGENT_ID ?? "not set"}`);

  await loadSeenIds();
  console.log(`[watchdog] Loaded ${seenMessageIds.size} previously seen breaches`);

  // Initial scan
  await processNewLines();

  // Watch for changes using polling (more reliable than fs.watch across platforms)
  const interval = setInterval(async () => {
    try {
      await processNewLines();
    } catch (err) {
      console.error("[watchdog] Error processing breach log:", err);
    }
  }, POLL_INTERVAL_MS);

  // Also use fs.watchFile as a faster trigger (stat-based, works everywhere)
  watchFile(BREACH_LOG_FILE_PATH, { interval: 1000 }, () => {
    processNewLines().catch((err) =>
      console.error("[watchdog] Error in file watcher:", err),
    );
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[watchdog] Shutting down");
    clearInterval(interval);
    unwatchFile(BREACH_LOG_FILE_PATH);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[watchdog] Fatal error:", err);
  process.exit(1);
});
