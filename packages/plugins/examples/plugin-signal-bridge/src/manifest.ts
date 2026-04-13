import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Signal Bridge",
  description: "Signal messenger bridge with 15s response SLA, 20s breach logging, fast-ack fallback, and auto-postmortem issue creation.",
  author: "Pax",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "agents.read",
    "issues.read",
    "issue.comments.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "webhooks.receive",
    "http.outbound",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      companyId: {
        type: "string",
        title: "Company ID",
        description: "UUID of the company. Auto-detected if omitted (single-company deployments).",
        default: "",
      },
      signalBridgeUrl: {
        type: "string",
        title: "Signal Bridge URL",
        description: "Base URL of the signal-cli REST API / signald bridge for sending outbound messages.",
        default: "",
      },
      signalBridgeApiKeyRef: {
        type: "string",
        title: "Signal Bridge API Key (secret ref)",
        description: "Plugin secret reference for the Signal bridge API key.",
        default: "",
      },
      signalWebhookSecretRef: {
        type: "string",
        title: "Inbound Webhook Secret (secret ref)",
        description: "HMAC secret for verifying inbound Signal webhook signatures.",
        default: "",
      },
      signalSendWebhookSecretRef: {
        type: "string",
        title: "Send Webhook Secret (secret ref)",
        description:
          "HMAC secret for verifying proactive signal-send webhook signatures. Required for secure outbound send.",
        default: "",
      },
      ctoAgentId: {
        type: "string",
        title: "CTO Agent ID",
        description: "Agent ID to assign auto-postmortem issues to on SLA breach.",
        default: "",
      },
      cooAgentId: {
        type: "string",
        title: "COO Agent ID",
        description: "Agent ID for the COO fast-ack fallback when target agent is slow.",
        default: "",
      },
      signalBotNumber: {
        type: "string",
        title: "Signal Bot Number",
        description: "The bot's own Signal phone number (used for reactions and message identification).",
        default: "",
      },
      defaultRecipientNumber: {
        type: "string",
        title: "Default Signal Recipient Number",
        description: "Jonathan's Signal phone number for outbound replies.",
        default: "",
      },
      authorizedSendAgentIds: {
        type: "string",
        title: "Authorized Send Agent IDs",
        description:
          "Comma-separated list of agent IDs allowed to call signal-send. Example: agent-1,agent-2",
        default: "",
      },
      outboundPerAgentPerMinuteLimit: {
        type: "number",
        title: "Outbound Per-Agent Per-Minute Limit",
        description: "Maximum proactive signal-send messages allowed per agent per minute.",
        default: 5,
        minimum: 1,
        maximum: 60,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.slaBreachCheck,
      displayName: "SLA Breach Check",
      description: "Scans pending messages for >20s breaches and files postmortem issues.",
      schedule: "* * * * *",
    },
    {
      jobKey: JOB_KEYS.staleSessionCleanup,
      displayName: "Stale Session Cleanup",
      description: "Closes abandoned agent sessions older than 30 minutes.",
      schedule: "*/15 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.signalSend,
      displayName: "Signal Proactive Send",
      description:
        "Accepts proactive outbound messages from agents. Payload: { message, role?, recipientNumber?, issueId? }",
    },
    {
      endpointKey: WEBHOOK_KEYS.signalIngest,
      displayName: "Signal Message Ingest",
      description:
        "Receives inbound Signal messages from the signal-cli bridge. Expected payload: { sender, timestamp, message, groupId?, mentions? }",
    },
  ],
};

export default manifest;
