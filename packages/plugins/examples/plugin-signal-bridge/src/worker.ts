// @ts-nocheck
import { appendFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, } from "@paperclipai/plugin-sdk";
import { BREACH_DEADLINE_MS, BREACH_LOG_FILE_PATH, BREACH_LOG_KEY, DEFAULT_OUTBOUND_PER_AGENT_PER_MINUTE_LIMIT, FAST_ACK_DEADLINE_MS, FOUNDER_REQUEST_LABEL_NAMES, INBOX_MSG_PREFIX, INBOX_NOTIFICATION_NAMESPACE, JOB_KEYS, MAX_BREACH_LOG_ENTRIES, MESSAGE_LOG_NAMESPACE, MESSAGE_LOG_PREFIX, OUTBOUND_RATE_LIMIT_NAMESPACE, PENDING_MSG_PREFIX, SLA_NAMESPACE, WEBHOOK_KEYS, } from "./constants.js";
import { resolveRouting } from "./routing.js";
import { formatQuoteContext } from "./quote-context.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Mask all but last 4 chars of a sender identifier (phone number). */
function maskSender(sender) {
    if (!sender || sender.length <= 4) return sender ?? "unknown";
    return "***" + sender.slice(-4);
}
let ctx;
let config;
let companyId;
function messageLogScopeKey(stateKey) {
    return {
        scopeKind: "company",
        scopeId: companyId,
        namespace: MESSAGE_LOG_NAMESPACE,
        stateKey,
    };
}
/**
 * Persist inbound/outbound Signal messages so agents can query history
 * on subsequent heartbeats.
 */
async function persistSignalMessage(opts) {
    const key = `${MESSAGE_LOG_PREFIX}${Date.now()}-${opts.direction}-${opts.msgId}`;
    const record = {
        direction: opts.direction,
        sender: opts.direction === "inbound" ? maskSender(opts.sender) : "bot",
        recipient: opts.direction === "outbound" ? maskSender(opts.recipient ?? "") : undefined,
        content: opts.content,
        signalTimestamp: opts.signalTimestamp ?? null,
        routedToAgentId: opts.routedToAgentId ?? null,
        createdAt: new Date().toISOString(),
    };
    try {
        await ctx.state.set(messageLogScopeKey(key), record);
    }
    catch (err) {
        ctx.logger.error("Failed to persist Signal message to history", {
            error: String(err),
            direction: opts.direction,
            msgId: opts.msgId,
        });
    }
}
/** Fast-ack timers indexed by pending message ID. */
const fastAckTimers = new Map();
/** Breach timers indexed by pending message ID. */
const breachTimers = new Map();
/** In-memory index: agentId -> pending msgIds for event-based correlation. */
const pendingByAgent = new Map();

function addPendingAgentIndex(agentId, msgId) {
    let msgIds = pendingByAgent.get(agentId);
    if (!msgIds) {
        msgIds = new Set();
        pendingByAgent.set(agentId, msgIds);
    }
    msgIds.add(msgId);
}

function removePendingAgentIndex(agentId, msgId) {
    const msgIds = pendingByAgent.get(agentId);
    if (!msgIds)
        return;
    msgIds.delete(msgId);
    if (msgIds.size === 0)
        pendingByAgent.delete(agentId);
}
/**
 * Look up the pending Signal message being handled by a given agent.
 * Returns the msgId if found, null otherwise.
 */
async function findPendingMsgForAgent(agentId) {
    const msgIds = pendingByAgent.get(agentId);
    if (!msgIds || msgIds.size === 0)
        return null;
    for (const msgId of msgIds) {
        const pending = await getPending(msgId);
        if (!pending || pending.respondedAt || !Array.isArray(pending.targetAgentIds) || !pending.targetAgentIds.includes(agentId)) {
            removePendingAgentIndex(agentId, msgId);
            continue;
        }
        return msgId;
    }
    return null;
}
async function loadConfig() {
    const raw = await ctx.config.get();
    config = (raw ?? {});
    return config;
}
/** Resolve the company ID from config or by listing companies. */
async function resolveCompanyId() {
    if (config.companyId)
        return config.companyId;
    const companies = await ctx.companies.list({ limit: 1 });
    if (companies.length === 0)
        throw new Error("No companies found");
    return companies[0].id;
}
function pendingStateKey(msgId) {
    return `${PENDING_MSG_PREFIX}${msgId}`;
}
function scopeKey(stateKey) {
    return {
        scopeKind: "instance",
        namespace: SLA_NAMESPACE,
        stateKey,
    };
}
async function getPending(msgId) {
    const val = await ctx.state.get(scopeKey(pendingStateKey(msgId)));
    return val ?? null;
}
async function setPending(msg) {
    await ctx.state.set(scopeKey(pendingStateKey(msg.id)), msg);
}
async function deletePending(msgId) {
    await ctx.state.delete(scopeKey(pendingStateKey(msgId)));
}
function inboxScopeKey(stateKey) {
    return {
        scopeKind: "instance",
        namespace: INBOX_NOTIFICATION_NAMESPACE,
        stateKey,
    };
}
async function storeInboxMapping(signalTimestamp, mapping) {
    await ctx.state.set(inboxScopeKey(`${INBOX_MSG_PREFIX}${signalTimestamp}`), mapping);
}
async function getInboxMapping(signalTimestamp) {
    const val = await ctx.state.get(inboxScopeKey(`${INBOX_MSG_PREFIX}${signalTimestamp}`));
    return val ?? null;
}
function outboundRateLimitScopeKey(stateKey) {
    return {
        scopeKind: "instance",
        namespace: OUTBOUND_RATE_LIMIT_NAMESPACE,
        stateKey,
    };
}
/**
 * Format an inbox notification message for Signal.
 * Example: "[PAX-6] completed by CTO Alpha — Widget implementation. 👍 to approve."
 */
function formatInboxNotification(identifier, title, status, agentName) {
    const action = status === "done" ? "completed" : status === "in_review" ? "ready for review" : status;
    const byLine = agentName ? ` by ${agentName}` : "";
    // Truncate title to keep message concise
    const shortTitle = title.length > 60 ? title.slice(0, 57) + "..." : title;
    return `[${identifier}] ${action}${byLine} — ${shortTitle}. 👍 to approve.`;
}
function hasFounderRequestLabel(issue) {
    const labels = Array.isArray(issue?.labels) ? issue.labels : [];
    if (labels.length === 0)
        return false;
    const names = new Set(labels.map((label) => String(label?.name ?? "").toLowerCase()));
    return FOUNDER_REQUEST_LABEL_NAMES.some((name) => names.has(name));
}
function parseSignalSendWebhookPayload(payload) {
    const agentId = typeof payload?.agentId === "string" && payload.agentId.trim().length > 0
        ? payload.agentId.trim()
        : "";
    if (!agentId)
        return null;
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message)
        return null;
    const role = typeof payload?.role === "string" && payload.role.trim().length > 0
        ? payload.role.trim()
        : null;
    const recipientNumber = typeof payload?.recipientNumber === "string" && payload.recipientNumber.trim().length > 0
        ? payload.recipientNumber.trim()
        : null;
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim().length > 0
        ? payload.issueId.trim()
        : null;
    return { agentId, message, role, recipientNumber, issueId };
}
function formatProactiveOutboundMessage(message, role) {
    if (!role)
        return message;
    return `**PAX.${role.toUpperCase()}:** ${message}`;
}
function parseAuthorizedSendAgentIds(rawValue) {
    if (typeof rawValue !== "string")
        return new Set();
    return new Set(rawValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean));
}
function normalizeHeaderValue(value) {
    if (Array.isArray(value))
        return value[0] ?? "";
    return typeof value === "string" ? value : "";
}
function resolveSenderAgentId(input, parsed) {
    const headerAgentId = normalizeHeaderValue(input.headers["x-paperclip-agent-id"]);
    if (headerAgentId && headerAgentId !== parsed.agentId) {
        throw new Error("agent identity mismatch between header and payload");
    }
    return headerAgentId || parsed.agentId;
}
function verifyHmacSignature(rawBody, headers, secret, headerKeys) {
    for (const headerKey of headerKeys) {
        const sig = normalizeHeaderValue(headers[headerKey]);
        if (!sig)
            continue;
        const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
        try {
            if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
                return true;
            }
        }
        catch {
            continue;
        }
    }
    return false;
}
function sanitizeOutboundMessage(rawMessage) {
    const redactions = [];
    let safe = rawMessage;
    const redact = (pattern, label, replacement) => {
        if (!pattern.test(safe))
            return;
        redactions.push(label);
        safe = safe.replace(pattern, replacement);
    };
    redact(/\bPAX-\d+\b/g, "issue_ids", "[internal-issue]");
    redact(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "emails", "[redacted-email]");
    redact(/\b\d{3}-\d{2}-\d{4}\b/g, "ssn", "[redacted-ssn]");
    redact(/\b(?:\+?\d[\d()\-\s]{7,}\d)\b/g, "phone_numbers", "[redacted-phone]");
    redact(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "secret_kv", "[redacted-secret]");
    redact(/\bsk-[A-Za-z0-9]{20,}\b/g, "openai_secret", "[redacted-secret]");
    redact(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, "github_token", "[redacted-secret]");
    redact(/\bAKIA[0-9A-Z]{16}\b/g, "aws_access_key", "[redacted-secret]");
    redact(/\bauthorization:\s*bearer\s+\S+/gi, "bearer_token", "authorization: bearer [redacted]");
    redact(/\b(?:https?:\/\/|ws:\/\/)\S+\b/gi, "links", "[redacted-link]");
    if (safe.length > 1000) {
        redactions.push("message_truncated");
        safe = `${safe.slice(0, 997)}...`;
    }
    const normalized = safe.trim() || "[message redacted due to policy]";
    return { text: normalized, redactions };
}
function resolveOutboundPerAgentLimit() {
    const raw = Number(config.outboundPerAgentPerMinuteLimit);
    if (Number.isFinite(raw) && raw >= 1) {
        return Math.floor(raw);
    }
    return DEFAULT_OUTBOUND_PER_AGENT_PER_MINUTE_LIMIT;
}
async function enforceOutboundPerAgentRateLimit(agentId) {
    const limit = resolveOutboundPerAgentLimit();
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const stateKey = `${agentId}:${minuteBucket}`;
    const current = Number(await ctx.state.get(outboundRateLimitScopeKey(stateKey))) || 0;
    if (current >= limit) {
        return { ok: false, limit, count: current };
    }
    await ctx.state.set(outboundRateLimitScopeKey(stateKey), current + 1);
    return { ok: true, limit, count: current + 1 };
}
// ---------------------------------------------------------------------------
// Signal reaction handler (👍 to mark issue reviewed)
// ---------------------------------------------------------------------------
async function handleSignalReaction(sender, reaction) {
    // Ignore reaction removals
    if (reaction.isRemove) {
        ctx.logger.debug("Ignoring reaction removal", {
            emoji: reaction.emoji,
            targetTimestamp: reaction.targetTimestamp,
        });
        return;
    }
    // Only handle thumbs-up
    if (reaction.emoji !== "👍") {
        ctx.logger.debug("Ignoring non-thumbs-up reaction", {
            emoji: reaction.emoji,
            targetTimestamp: reaction.targetTimestamp,
        });
        return;
    }
    // Look up the inbox message mapping using the target message timestamp
    const mapping = await getInboxMapping(reaction.targetTimestamp);
    if (!mapping) {
        ctx.logger.debug("No inbox mapping found for reaction target", {
            targetTimestamp: reaction.targetTimestamp,
        });
        return;
    }
    ctx.logger.info("Processing thumbs-up reaction for issue", {
        issueId: mapping.issueId,
        identifier: mapping.identifier,
        sender,
    });
    try {
        // Mark the issue as reviewed by setting status to done
        await ctx.issues.update(mapping.issueId, { status: "done" }, companyId);
        // Post acknowledgement comment on the issue
        await ctx.issues.createComment(mapping.issueId, `${mapping.identifier} approved via Signal 👍 reaction. ✓`, companyId);
        // Send ack reply to Signal
        const recipientNumber = config.defaultRecipientNumber || sender;
        await sendSignalReply(recipientNumber, `${mapping.identifier} approved. ✓`);
        ctx.logger.info("Issue approved via Signal reaction", {
            issueId: mapping.issueId,
            identifier: mapping.identifier,
        });
    }
    catch (err) {
        ctx.logger.error("Failed to process thumbs-up reaction", {
            error: String(err),
            issueId: mapping.issueId,
            identifier: mapping.identifier,
        });
    }
}
// ---------------------------------------------------------------------------
// Signal bridge outbound (send reply back to Signal)
// ---------------------------------------------------------------------------
async function sendSignalReply(recipientNumber, text) {
    if (!config.signalBridgeUrl) {
        ctx.logger.warn("signalBridgeUrl not configured — cannot send reply", {
            recipientNumber,
        });
        return;
    }
    let apiKey;
    if (config.signalBridgeApiKeyRef) {
        apiKey = await ctx.secrets.resolve(config.signalBridgeApiKeyRef);
    }
    const headers = {
        "Content-Type": "application/json",
    };
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    try {
        await ctx.http.fetch(`${config.signalBridgeUrl}/v2/send`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                number: recipientNumber,
                message: text,
            }),
        });
        ctx.logger.info("Signal reply sent", { recipientNumber });
        void persistSignalMessage({
            direction: "outbound",
            msgId: `out-${Date.now()}`,
            sender: "bot",
            recipient: recipientNumber,
            content: text,
        });
    }
    catch (err) {
        ctx.logger.error("Failed to send Signal reply", {
            error: String(err),
            recipientNumber,
        });
    }
}
// ---------------------------------------------------------------------------
// Signal reactions (👀 lifecycle)
// ---------------------------------------------------------------------------
async function getSignalAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (config.signalBridgeApiKeyRef) {
        const apiKey = await ctx.secrets.resolve(config.signalBridgeApiKeyRef);
        if (apiKey)
            headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return headers;
}
/**
 * Send a reaction emoji on a specific Signal message.
 * Uses signal-cli-rest-api: PUT /v1/reactions/{botNumber}
 */
async function sendSignalReaction(recipientNumber, targetAuthor, targetTimestamp, emoji) {
    if (!config.signalBridgeUrl || !config.signalBotNumber) {
        ctx.logger.warn("signalBridgeUrl or signalBotNumber not configured — cannot send reaction", {
            recipientNumber,
            emoji,
        });
        return;
    }
    const headers = await getSignalAuthHeaders();
    try {
        await ctx.http.fetch(`${config.signalBridgeUrl}/v1/reactions/${encodeURIComponent(config.signalBotNumber)}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
                recipient: recipientNumber,
                reaction: emoji,
                target_author: targetAuthor,
                target_sent_timestamp: targetTimestamp,
            }),
        });
        ctx.logger.info("Signal reaction sent", { recipientNumber, emoji, targetTimestamp });
    }
    catch (err) {
        ctx.logger.error("Failed to send Signal reaction", {
            error: String(err),
            recipientNumber,
            emoji,
        });
    }
}
/**
 * Remove a reaction emoji from a specific Signal message.
 * Uses signal-cli-rest-api: DELETE /v1/reactions/{botNumber}
 */
async function removeSignalReaction(recipientNumber, targetAuthor, targetTimestamp, emoji) {
    if (!config.signalBridgeUrl || !config.signalBotNumber) {
        ctx.logger.warn("signalBridgeUrl or signalBotNumber not configured — cannot remove reaction");
        return;
    }
    const headers = await getSignalAuthHeaders();
    try {
        await ctx.http.fetch(`${config.signalBridgeUrl}/v1/reactions/${encodeURIComponent(config.signalBotNumber)}`, {
            method: "DELETE",
            headers,
            body: JSON.stringify({
                recipient: recipientNumber,
                reaction: emoji,
                target_author: targetAuthor,
                target_sent_timestamp: targetTimestamp,
            }),
        });
        ctx.logger.info("Signal reaction removed", { recipientNumber, emoji, targetTimestamp });
    }
    catch (err) {
        ctx.logger.error("Failed to remove Signal reaction", {
            error: String(err),
            recipientNumber,
            emoji,
        });
    }
}
/**
 * Fire 👀 reaction on a pending message's originating Signal message.
 * No-op if already sent or if message is already responded to.
 */
async function fireEyesReaction(msgId) {
    const pending = await getPending(msgId);
    if (!pending || pending.eyesReactionSent || pending.respondedAt)
        return;
    const senderNumber = config.defaultRecipientNumber || pending.sender;
    await sendSignalReaction(senderNumber, pending.sender, pending.signalTimestamp, "👀");
    pending.eyesReactionSent = true;
    await setPending(pending);
}
/**
 * Remove 👀 reaction from a pending message's originating Signal message.
 * No-op if eyes were never sent.
 */
async function clearEyesReaction(msgId) {
    const pending = await getPending(msgId);
    if (!pending || !pending.eyesReactionSent)
        return;
    const senderNumber = config.defaultRecipientNumber || pending.sender;
    await removeSignalReaction(senderNumber, pending.sender, pending.signalTimestamp, "👀");
}
// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------
function verifyWebhookSignature(rawBody, headers, secret) {
    return verifyHmacSignature(rawBody, headers, secret, ["x-signal-signature", "x-hub-signature-256"]);
}
// ---------------------------------------------------------------------------
// Agent resolution from @mentions in message text
// ---------------------------------------------------------------------------
async function resolveTargetAgents(message, mentions) {
    try {
        const agents = await ctx.agents.list({
            companyId,
            limit: 200,
            offset: 0,
        });
        return resolveRouting(message, mentions, agents);
    }
    catch (err) {
        ctx.logger.error("Failed to resolve agent mentions", {
            error: String(err),
        });
        return { mentionTokens: [], targets: [] };
    }
}

function primaryTargetAgentId(pending) {
    if (Array.isArray(pending.targetAgentIds) && pending.targetAgentIds.length > 0) {
        return pending.targetAgentIds[0];
    }
    return null;
}

function targetAgentLabel(pending) {
    const ids = Array.isArray(pending.targetAgentIds) ? pending.targetAgentIds.filter(Boolean) : [];
    if (ids.length === 0)
        return "none";
    if (ids.length === 1)
        return ids[0];
    return "multi";
}
// ---------------------------------------------------------------------------
// Fast-ack fallback: COO acks if target agent is slow
// ---------------------------------------------------------------------------
function scheduleFastAck(msg, senderNumber) {
    const timer = setTimeout(async () => {
        fastAckTimers.delete(msg.id);
        const current = await getPending(msg.id);
        if (!current || current.respondedAt)
            return;
        const primaryTarget = primaryTargetAgentId(msg);
        ctx.logger.info("Fast-ack deadline reached, COO fallback", {
            messageId: msg.id,
            targetAgentId: primaryTarget,
        });
        current.fastAckSent = true;
        await setPending(current);
        const ackText = `Acknowledged — working on this now. ` +
            (primaryTarget
                ? `Routing to the right agent.`
                : `I'll handle it directly.`);
        await sendSignalReply(senderNumber, ackText);
        if (config.cooAgentId && !msg.targetAgentIds?.includes(config.cooAgentId)) {
            try {
                const session = await ctx.agents.sessions.create(config.cooAgentId, companyId, {
                    taskKey: `signal-fastack-${msg.id}`,
                    reason: `Fast-ack fallback for unanswered Signal message from ${maskSender(msg.sender)}`,
                });
                await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
                    prompt: `A Signal message from ${maskSender(msg.sender)} has gone unanswered for 15 seconds. ` +
                        `The original message: "${msg.message}". Please provide a substantive response. ` +
                        `The target agent(s) ${msg.targetAgentIds?.join(", ") || "(none)"} have not responded yet.`,
                    reason: "fast-ack-fallback",
                });
            }
            catch (err) {
                ctx.logger.error("Failed to create COO fast-ack session", {
                    error: String(err),
                });
            }
        }
        await ctx.metrics.write("signal.fast_ack_triggered", 1, {
            target_agent: targetAgentLabel(msg),
        });
    }, FAST_ACK_DEADLINE_MS);
    fastAckTimers.set(msg.id, timer);
}
// ---------------------------------------------------------------------------
// Breach detection timer
// ---------------------------------------------------------------------------
function scheduleBreachCheck(msg) {
    const timer = setTimeout(async () => {
        breachTimers.delete(msg.id);
        const current = await getPending(msg.id);
        if (!current || current.respondedAt)
            return;
        ctx.logger.error("SLA BREACH: >20s with no agent response", {
            messageId: msg.id,
            sender: maskSender(msg.sender),
            targetAgentIds: msg.targetAgentIds ?? [],
            receivedAt: msg.receivedAt,
            elapsedMs: Date.now() - msg.receivedAt,
        });
        await fileBreachPostmortem(current);
    }, BREACH_DEADLINE_MS);
    breachTimers.set(msg.id, timer);
}
// ---------------------------------------------------------------------------
// Auto-postmortem: file issue on SLA breach
// ---------------------------------------------------------------------------
async function fileBreachPostmortem(msg) {
    if (msg.breachFiled)
        return;
    const now = Date.now();
    const latencyMs = msg.respondedAt ? msg.respondedAt - msg.receivedAt : null;
    const breachEntry = {
        messageId: msg.id,
        sender: maskSender(msg.sender),
        receivedAt: msg.receivedAt,
        firstReplyAt: msg.respondedAt,
        targetAgentId: primaryTargetAgentId(msg),
        targetAgentIds: Array.isArray(msg.targetAgentIds) ? msg.targetAgentIds : [],
        latencyMs,
        breachDetectedAt: now,
        postmortemIssueId: null,
    };
    let postmortemIssueId = null;
    try {
        const issue = await ctx.issues.create({
            companyId,
            title: `SLA Breach Postmortem: ${maskSender(msg.sender)} message unanswered >20s`,
            description: `## SLA Breach Auto-Postmortem\n\n` +
                `**Message ID:** ${msg.id}\n` +
                `**Sender:** ${maskSender(msg.sender)}\n` +
                `**Received at:** ${new Date(msg.receivedAt).toISOString()}\n` +
                `**Target agent(s):** ${msg.targetAgentIds?.join(", ") || "none"}\n` +
                `**First reply at:** ${msg.respondedAt ? new Date(msg.respondedAt).toISOString() : "NONE"}\n` +
                `**Latency:** ${latencyMs != null ? `${latencyMs}ms` : "no response"}\n` +
                `**Fast-ack sent:** ${msg.fastAckSent ? "yes" : "no"}\n` +
                `**Breach detected at:** ${new Date(now).toISOString()}\n\n` +
                `## Root Cause Investigation Required\n\n` +
                `- Was the target agent running?\n` +
                `- Was there a heartbeat/adapter failure?\n` +
                `- Was the server restarting?\n` +
                `- Was message routing slow?\n` +
                `- Was the agent session creation delayed?\n\n` +
                `Fix the underlying issue to prevent recurrence.`,
            priority: "critical",
            assigneeAgentId: config.ctoAgentId || undefined,
        });
        postmortemIssueId = issue.id;
        breachEntry.postmortemIssueId = issue.id;
        ctx.logger.info("Postmortem issue created", {
            issueId: issue.id,
            messageId: msg.id,
        });
    }
    catch (err) {
        ctx.logger.error("Failed to create postmortem issue", {
            error: String(err),
            messageId: msg.id,
        });
    }
    try {
        const existing = (await ctx.state.get(scopeKey(BREACH_LOG_KEY))) ??
            [];
        existing.unshift(breachEntry);
        if (existing.length > MAX_BREACH_LOG_ENTRIES)
            existing.length = MAX_BREACH_LOG_ENTRIES;
        await ctx.state.set(scopeKey(BREACH_LOG_KEY), existing);
    }
    catch (err) {
        ctx.logger.error("Failed to update breach log", {
            error: String(err),
        });
    }
    // Write to shared log file for the independent watchdog
    try {
        await appendFile(BREACH_LOG_FILE_PATH, JSON.stringify(breachEntry) + "\n", "utf-8");
    }
    catch (err) {
        ctx.logger.error("Failed to write breach to log file", {
            error: String(err),
            path: BREACH_LOG_FILE_PATH,
        });
    }
    msg.breachFiled = true;
    await setPending(msg);
    await ctx.metrics.write("signal.sla_breach", 1, {
        target_agent: targetAgentLabel(msg),
    });
    await ctx.activity.log({
        companyId,
        entityType: "issue",
        entityId: postmortemIssueId ?? msg.id,
        message: `SLA breach: ${maskSender(msg.sender)} message unanswered >20s. Target agent(s): ${msg.targetAgentIds?.join(", ") || "none"}.`,
        metadata: {
            messageId: msg.id,
            receivedAt: msg.receivedAt,
            latencyMs,
        },
    });
}
// ---------------------------------------------------------------------------
// Mark message as responded (called when agent replies)
// ---------------------------------------------------------------------------
async function markResponded(msgId) {
    const pending = await getPending(msgId);
    if (!pending || pending.respondedAt)
        return;
    pending.respondedAt = Date.now();
    const latencyMs = pending.respondedAt - pending.receivedAt;
    await setPending(pending);
    // Clean up all timers and indexes
    const fastTimer = fastAckTimers.get(msgId);
    if (fastTimer) {
        clearTimeout(fastTimer);
        fastAckTimers.delete(msgId);
    }
    const breachTimer = breachTimers.get(msgId);
    if (breachTimer) {
        clearTimeout(breachTimer);
        breachTimers.delete(msgId);
    }
    for (const targetAgentId of pending.targetAgentIds ?? []) {
        removePendingAgentIndex(targetAgentId, msgId);
    }
    await ctx.metrics.write("signal.response_latency_ms", latencyMs, {
        target_agent: targetAgentLabel(pending),
        fast_ack: pending.fastAckSent ? "true" : "false",
    });
    ctx.logger.info("Message responded", {
        messageId: msgId,
        latencyMs,
        targetAgentIds: pending.targetAgentIds ?? [],
    });
    setTimeout(() => deletePending(msgId), 5 * 60 * 1000);
}
// ---------------------------------------------------------------------------
// Inbound image attachment helpers
// ---------------------------------------------------------------------------

/** MIME types we accept as images from Signal attachments. */
const IMAGE_CONTENT_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
]);

/** Maximum attachment size we will fetch and base64-encode (5 MiB). */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Fetch a Signal attachment by ID from the signal-cli REST API and return it
 * as a base64-encoded content block suitable for `sendMessage`.
 *
 * Returns `null` if the attachment cannot be fetched, is too large, or is not
 * an image type we support.
 */
async function fetchAttachmentAsContentBlock(
    attachment: { contentType?: string; id?: string; size?: number; filename?: string },
): Promise<{ type: "image"; source: { type: "base64"; media_type: string; data: string } } | null> {
    const contentType = attachment.contentType ?? "";
    if (!IMAGE_CONTENT_TYPES.has(contentType)) {
        ctx.logger.debug("Skipping non-image attachment", {
            contentType,
            filename: attachment.filename ?? null,
        });
        return null;
    }

    if (!attachment.id) {
        ctx.logger.warn("Attachment missing id — cannot fetch", {
            contentType,
            filename: attachment.filename ?? null,
        });
        return null;
    }

    if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
        ctx.logger.warn("Attachment too large — skipping", {
            id: attachment.id,
            size: attachment.size,
            maxBytes: MAX_ATTACHMENT_BYTES,
        });
        return null;
    }

    if (!config.signalBridgeUrl) {
        ctx.logger.warn("signalBridgeUrl not configured — cannot fetch attachment");
        return null;
    }

    try {
        const headers = await getSignalAuthHeaders();
        const res = await ctx.http.fetch(
            `${config.signalBridgeUrl}/v1/attachments/${encodeURIComponent(attachment.id)}`,
            { method: "GET", headers },
        );

        if (res.status !== 200) {
            ctx.logger.warn("Failed to fetch attachment from Signal bridge", {
                id: attachment.id,
                status: res.status,
                statusText: res.statusText,
            });
            return null;
        }

        // The http.fetch helper returns the body as a string.
        // The signal-cli REST API returns binary data; the SDK http.fetch
        // helper base64-encodes binary responses for transport over JSON-RPC,
        // so `res.body` is already a base64 string for binary content types.
        // If not, we encode it ourselves.
        let base64Data: string;
        if (/^[A-Za-z0-9+/\r\n]+=*$/.test(res.body.slice(0, 200))) {
            // Already looks like base64
            base64Data = res.body.replace(/[\r\n]/g, "");
        } else {
            base64Data = Buffer.from(res.body, "binary").toString("base64");
        }

        ctx.logger.info("Fetched image attachment", {
            id: attachment.id,
            contentType,
            base64Length: base64Data.length,
        });

        return {
            type: "image" as const,
            source: {
                type: "base64" as const,
                media_type: contentType,
                data: base64Data,
            },
        };
    } catch (err) {
        ctx.logger.error("Error fetching attachment from Signal bridge", {
            error: String(err),
            id: attachment.id,
        });
        return null;
    }
}

/**
 * Process an array of Signal attachments and return content blocks for images.
 */
async function buildImageContentBlocks(
    attachments: Array<{ contentType?: string; id?: string; size?: number; filename?: string }> | undefined | null,
): Promise<Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>> {
    if (!attachments || attachments.length === 0) return [];

    const blocks: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    > = [];

    for (const att of attachments) {
        const block = await fetchAttachmentAsContentBlock(att);
        if (block) {
            blocks.push(block);
        }
    }

    return blocks;
}

// ---------------------------------------------------------------------------
// Main message handler: receive Signal message, route to agent
// ---------------------------------------------------------------------------
async function handleSignalMessage(payload) {
    const msgId = `${payload.sender}-${payload.timestamp}`;
    const quotePrefix = formatQuoteContext(payload.quote);
    const receivedAt = Date.now();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    ctx.logger.info("Signal message received", {
        messageId: msgId,
        sender: maskSender(payload.sender),
        hasText: !!payload.message,
        attachmentCount: attachments.length,
    });

    // Build content blocks from image attachments (runs in parallel with routing)
    const [routing, contentBlocks] = await Promise.all([
        resolveTargetAgents(payload.message, payload.mentions),
        buildImageContentBlocks(attachments),
    ]);
    const hasExplicitMentions = routing.mentionTokens.length > 0;
    const resolvedTargets = routing.targets;
    const fallbackTargets = hasExplicitMentions
        ? []
        : config.cooAgentId
            ? [{ agentId: config.cooAgentId, agentName: "COO Fallback" }]
            : [];
    const targetAgents = resolvedTargets.length > 0 ? resolvedTargets : fallbackTargets;
    const targetAgentIds = targetAgents.map((target) => target.agentId);
    const pending = {
        id: msgId,
        sender: payload.sender,
        message: payload.message,
        signalTimestamp: payload.timestamp,
        receivedAt,
        targetAgentIds,
        sessionIds: [],
        fastAckSent: false,
        respondedAt: null,
        breachFiled: false,
        eyesReactionSent: false,
    };
    await setPending(pending);
    void persistSignalMessage({
        direction: "inbound",
        msgId,
        sender: payload.sender,
        content: payload.message,
        signalTimestamp: payload.timestamp,
        routedToAgentId: targetAgentIds[0] ?? null,
        quoteText: payload.quote?.text ?? null,
        quoteAuthor: payload.quote?.author ? maskSender(payload.quote.author) : null,
        attachmentCount: attachments.length,
        imageContentBlockCount: contentBlocks.filter((b) => b.type === "image").length,
    });
    await ctx.metrics.write("signal.message_received", 1, {
        has_mention: hasExplicitMentions ? "true" : "false",
        target_count: String(targetAgentIds.length),
        image_count: String(contentBlocks.filter((b) => b.type === "image").length),
    });
    const senderNumber = config.defaultRecipientNumber || payload.sender;
    if (hasExplicitMentions && targetAgents.length === 0) {
        ctx.logger.warn("Message contains explicit @mentions but no matching agents were found", {
            messageId: msgId,
            mentionTokens: routing.mentionTokens,
        });
        await sendSignalReply(senderNumber, "I could not resolve the mentioned agent(s). Please use exact @agent names.");
        return;
    }
    scheduleFastAck(pending, senderNumber);
    scheduleBreachCheck(pending);
    if (targetAgents.length === 0) {
        ctx.logger.warn("No target agent and no COO configured", {
            messageId: msgId,
        });
        return;
    }
    await Promise.all(targetAgents.map(async (target) => {
        const agentId = target.agentId;
        addPendingAgentIndex(agentId, msgId);
        try {
            const session = await ctx.agents.sessions.create(agentId, companyId, {
                taskKey: `signal-${msgId}-${agentId}`,
                reason: `Signal message from ${maskSender(payload.sender)}`,
            });
            pending.sessionIds.push(session.sessionId);
            await setPending(pending);
            const sendOpts: {
                prompt: string;
                reason?: string;
                onEvent?: (event: any) => void;
                contentBlocks?: Array<
                    | { type: "text"; text: string }
                    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
                >;
            } = {
                prompt: quotePrefix + payload.message,
                reason: `Signal message from ${maskSender(payload.sender)}`,
                onEvent: (event) => {
                    if (event.eventType === "done" && event.message) {
                        void clearEyesReaction(msgId).then(() => {
                            const replyText = targetAgents.length > 1
                                ? `[${target.agentName}] ${event.message}`
                                : event.message;
                            sendSignalReply(senderNumber, replyText);
                            markResponded(msgId);
                        });
                    }
                },
            };
            // Attach image content blocks if present
            if (contentBlocks.length > 0) {
                sendOpts.contentBlocks = contentBlocks;
                ctx.logger.info("Attaching image content blocks to agent session message", {
                    messageId: msgId,
                    agentId,
                    imageCount: contentBlocks.length,
                });
            }
            await ctx.agents.sessions.sendMessage(session.sessionId, companyId, sendOpts);
            // Fire 👀 after session message dispatch — the agent is now processing.
            // fireEyesReaction is idempotent (no-ops if already sent), so this is
            // safe even if the issue.checked_out event fires first.
            void fireEyesReaction(msgId);
        }
        catch (err) {
            ctx.logger.error("Failed to route message to agent", {
                error: String(err),
                messageId: msgId,
                agentId,
            });
            removePendingAgentIndex(agentId, msgId);
        }
    }));
}
// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------
const plugin = definePlugin({
    async setup(context) {
        ctx = context;
        await loadConfig();
        companyId = await resolveCompanyId();
        ctx.logger.info("Signal Bridge plugin starting", {
            companyId,
            hasBridgeUrl: !!config.signalBridgeUrl,
            hasCtoAgent: !!config.ctoAgentId,
            hasCooAgent: !!config.cooAgentId,
        });
        // --- Jobs ---
        ctx.jobs.register(JOB_KEYS.slaBreachCheck, async (_job) => {
            ctx.logger.info("Running SLA breach check job");
            const breachLog = (await ctx.state.get(scopeKey(BREACH_LOG_KEY))) ?? [];
            await ctx.metrics.write("signal.breach_log_total", breachLog.length);
        });
        ctx.jobs.register(JOB_KEYS.staleSessionCleanup, async (_job) => {
            ctx.logger.info("Running stale session cleanup");
        });
        // --- Events: fire 👀 on checkout, clean up on run failure ---
        // Issue-based flow: fire 👀 when an agent checks out a task that
        // originated from a Signal message. The correlation uses the
        // targetAgentId stored in the pending message.
        ctx.events.on("issue.checked_out", async (event) => {
            const payload = event.payload;
            const checkoutAgentId = payload?.agentId;
            if (!checkoutAgentId)
                return;
            // Scan pending messages to find one targeting this agent
            const msgId = await findPendingMsgForAgent(checkoutAgentId);
            if (msgId) {
                ctx.logger.info("Issue checkout matched pending Signal message — firing 👀", {
                    issueId: event.entityId,
                    agentId: checkoutAgentId,
                    messageId: msgId,
                });
                await fireEyesReaction(msgId);
            }
        });
        // Safety net: if agent run finishes without a reply (crash/error),
        // clean up the 👀 reaction after a grace period rather than leaving
        // it lingering indefinitely.
        ctx.events.on("agent.run.finished", async (event) => {
            ctx.logger.debug("Agent run finished event received", {
                entityId: event.entityId,
            });
        });
        ctx.events.on("agent.run.failed", async (event) => {
            const payload = event.payload;
            const agentId = payload?.agentId;
            if (!agentId)
                return;
            const msgId = await findPendingMsgForAgent(agentId);
            if (msgId) {
                ctx.logger.warn("Agent run failed — removing stale 👀 reaction", {
                    agentId,
                    messageId: msgId,
                });
                await clearEyesReaction(msgId);
            }
        });
        // --- Events: founder-request notification when issue enters in_review ---
        ctx.events.on("issue.updated", async (event) => {
            const payload = event.payload;
            if (!payload)
                return;
            const status = payload.status;
            const previousStatus = payload.previousStatus;
            // Only fire on transitions INTO in_review (for founder-request issues).
            if (status !== "in_review")
                return;
            if (previousStatus === "in_review")
                return;
            const recipientNumber = config.defaultRecipientNumber;
            if (!recipientNumber) {
                ctx.logger.debug("No defaultRecipientNumber configured — skipping inbox notification");
                return;
            }
            // Fetch issue details for the notification
            const issueId = event.entityId;
            if (!issueId)
                return;
            try {
                const target = await ctx.issues.get(issueId, companyId);
                if (!target) {
                    ctx.logger.warn("Could not find issue for inbox notification", { issueId });
                    return;
                }
                if (!hasFounderRequestLabel(target)) {
                    ctx.logger.debug("Issue is not labeled founder-request — skipping notification", {
                        issueId,
                        identifier: target.identifier ?? null,
                    });
                    return;
                }
                const identifier = target.identifier ?? issueId.slice(0, 8);
                const title = target.title ?? "Untitled";
                // Resolve agent name if there's an assignee
                let agentName = null;
                const assigneeAgentId = target.assigneeAgentId;
                if (assigneeAgentId) {
                    try {
                        const agents = await ctx.agents.list({ companyId });
                        const agent = agents.find((a) => a.id === assigneeAgentId);
                        agentName = agent ? agent.name : null;
                    }
                    catch {
                        // Non-critical — proceed without agent name
                    }
                }
                const message = formatInboxNotification(identifier, title, status, agentName);
                await sendSignalReply(recipientNumber, message);
                // Store mapping for reaction handling (consumed by thumbs-up handler)
                // Use current timestamp as the Signal message timestamp proxy
                // (the actual Signal timestamp would come from the send response in a real implementation)
                const signalTimestamp = Date.now();
                await storeInboxMapping(signalTimestamp, {
                    issueId,
                    identifier,
                    signalTimestamp,
                    sentAt: Date.now(),
                });
                ctx.logger.info("Inbox notification sent to Signal", {
                    issueId,
                    identifier,
                    status,
                    recipientNumber,
                });
                await ctx.activity.log({
                    companyId,
                    entityType: "issue",
                    entityId: issueId,
                    message: `Signal founder-request notification sent: ${message}`,
                    metadata: { status, signalTimestamp },
                });
            }
            catch (err) {
                ctx.logger.error("Failed to send inbox notification", {
                    error: String(err),
                    issueId,
                });
            }
        });
    },
    async onWebhook(input) {
        await loadConfig();
        companyId = await resolveCompanyId();
        if (input.endpointKey === WEBHOOK_KEYS.signalSend) {
            const parsed = parseSignalSendWebhookPayload(input.parsedBody);
            if (!parsed) {
                ctx.logger.warn("signal-send payload invalid (missing agentId/message)", {
                    requestId: input.requestId,
                });
                return;
            }
            const senderAgentId = resolveSenderAgentId(input, parsed);
            if (!senderAgentId) {
                ctx.logger.warn("signal-send missing sender agent identity", {
                    requestId: input.requestId,
                });
                return;
            }
            const sendSecretRef = typeof config.signalSendWebhookSecretRef === "string" && config.signalSendWebhookSecretRef.trim()
                ? config.signalSendWebhookSecretRef.trim()
                : "";
            if (!sendSecretRef) {
                ctx.logger.error("signal-send rejected: signalSendWebhookSecretRef is not configured", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                });
                return;
            }
            const sendSecret = await ctx.secrets.resolve(sendSecretRef);
            const hasValidSignature = verifyHmacSignature(input.rawBody, input.headers, sendSecret, [
                "x-paperclip-signature",
                "x-signal-signature",
                "x-hub-signature-256",
            ]);
            if (!hasValidSignature) {
                ctx.logger.warn("signal-send rejected: invalid signature", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                });
                return;
            }
            const agent = await ctx.agents.get(senderAgentId, companyId);
            if (!agent) {
                ctx.logger.warn("signal-send rejected: agent not found in company", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                });
                return;
            }
            const allowedAgents = parseAuthorizedSendAgentIds(config.authorizedSendAgentIds);
            if (!allowedAgents.has(senderAgentId)) {
                ctx.logger.warn("signal-send rejected: agent not on allowlist", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                    configuredAllowlistSize: allowedAgents.size,
                });
                return;
            }
            const rateLimit = await enforceOutboundPerAgentRateLimit(senderAgentId);
            if (!rateLimit.ok) {
                ctx.logger.warn("signal-send rejected: per-agent rate limit exceeded", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                    limitPerMinute: rateLimit.limit,
                });
                return;
            }
            const defaultRecipientNumber = typeof config.defaultRecipientNumber === "string"
                ? config.defaultRecipientNumber.trim()
                : "";
            const requestedRecipient = parsed.recipientNumber ? parsed.recipientNumber.trim() : "";
            if (!defaultRecipientNumber) {
                ctx.logger.warn("No defaultRecipientNumber configured for proactive send", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                });
                return;
            }
            if (requestedRecipient && requestedRecipient !== defaultRecipientNumber) {
                ctx.logger.warn("signal-send rejected: recipient not in allowlist", {
                    requestId: input.requestId,
                    agentId: senderAgentId,
                    recipientNumber: requestedRecipient,
                });
                return;
            }
            const recipientNumber = defaultRecipientNumber;
            if (!recipientNumber) {
                ctx.logger.warn("No recipient number configured for proactive send", {
                    requestId: input.requestId,
                });
                return;
            }
            const sanitized = sanitizeOutboundMessage(parsed.message);
            const outbound = formatProactiveOutboundMessage(sanitized.text, parsed.role);
            await sendSignalReply(recipientNumber, outbound);
            const activityMetadata = {
                recipientNumber,
                role: parsed.role,
                senderAgentId,
                requestId: input.requestId,
                redactions: sanitized.redactions,
                rateLimitPerMinute: rateLimit.limit,
            };
            if (parsed.issueId) {
                await ctx.activity.log({
                    companyId,
                    entityType: "issue",
                    entityId: parsed.issueId,
                    message: "Signal proactive founder notification sent",
                    metadata: activityMetadata,
                });
            }
            else {
                await ctx.activity.log({
                    companyId,
                    entityType: "company",
                    entityId: companyId,
                    message: "Signal proactive founder notification sent (no issueId provided)",
                    metadata: activityMetadata,
                });
            }
            return;
        }
        if (input.endpointKey !== WEBHOOK_KEYS.signalIngest) {
            ctx.logger.warn("Unknown webhook endpoint", {
                endpointKey: input.endpointKey,
            });
            return;
        }
        if (config.signalWebhookSecretRef) {
            try {
                const secret = await ctx.secrets.resolve(config.signalWebhookSecretRef);
                if (!verifyWebhookSignature(input.rawBody, input.headers, secret)) {
                    ctx.logger.error("Webhook signature verification failed", {
                        requestId: input.requestId,
                    });
                    return;
                }
            }
            catch (err) {
                ctx.logger.error("Failed to verify webhook signature", {
                    error: String(err),
                });
                return;
            }
        }
        const payload = input.parsedBody;
        // Handle reactions (e.g. 👍 to mark issue reviewed) before text messages
        if (payload?.reaction) {
            await handleSignalReaction(payload.sender, payload.reaction);
            return;
        }
        const hasAttachments = Array.isArray(payload?.attachments) && payload.attachments.length > 0;
        if (!payload?.message && !hasAttachments) {
            ctx.logger.warn("Webhook payload missing message, attachments, and reaction fields", {
                requestId: input.requestId,
            });
            return;
        }
        // Ensure message is at least an empty string when only attachments are present
        if (!payload.message && hasAttachments) {
            payload.message = "";
        }
        // At this point message is guaranteed (possibly empty with attachments) — safe to handle
        await handleSignalMessage(payload);
    },
    async onConfigChanged() {
        await loadConfig();
        companyId = await resolveCompanyId();
        ctx.logger.info("Config reloaded", {
            hasBridgeUrl: !!config.signalBridgeUrl,
        });
    },
    async onHealth() {
        const breachLog = (await ctx.state.get(scopeKey(BREACH_LOG_KEY))) ?? [];
        const recentBreaches = breachLog.filter((b) => b.breachDetectedAt > Date.now() - 3600_000);
        return {
            status: recentBreaches.length > 3 ? "degraded" : "ok",
            details: {
                activePendingMessages: fastAckTimers.size,
                totalBreachesLogged: breachLog.length,
                breachesLastHour: recentBreaches.length,
                hasBridgeUrl: !!config.signalBridgeUrl,
                hasCtoAgent: !!config.ctoAgentId,
                hasCooAgent: !!config.cooAgentId,
            },
        };
    },
    async onShutdown() {
        for (const timer of fastAckTimers.values())
            clearTimeout(timer);
        for (const timer of breachTimers.values())
            clearTimeout(timer);
        fastAckTimers.clear();
        breachTimers.clear();
        pendingByAgent.clear();
        ctx.logger.info("Signal Bridge plugin shut down");
    },
});
runWorker(plugin, import.meta.url);
//# sourceMappingURL=worker.js.map
