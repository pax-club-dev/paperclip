import type { Agent } from "@paperclipai/shared";

export interface SignalMention {
  name?: string;
}

export interface ResolvedTargetAgent {
  agentId: string;
  agentName: string;
}

export interface RoutingResolution {
  mentionTokens: string[];
  targets: ResolvedTargetAgent[];
}

const INLINE_MENTION_REGEX = /(?:^|\s)@([A-Za-z0-9._-]+)/g;
const ROLE_PREFIX_REGEX = /(?:^|\s)(CTO|COO|CPO|CMO|CFO|CISO|CLO|CEO)\s*:/gi;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenizeField(value: string): string[] {
  const tokens = new Set<string>();
  const normalized = normalizeToken(value);
  if (normalized) tokens.add(normalized);
  const parts = value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => normalizeToken(part))
    .filter((part) => part.length > 0);
  for (const part of parts) tokens.add(part);
  return [...tokens];
}

function indexAgent(agent: Agent): Set<string> {
  const keys = new Set<string>();
  const fields = [agent.name, agent.urlKey, agent.title ?? "", agent.role];
  for (const field of fields) {
    for (const token of tokenizeField(field)) keys.add(token);
  }
  return keys;
}

export function extractMentionTokens(message: string, mentions?: SignalMention[]): string[] {
  const tokens = new Set<string>();

  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      if (typeof mention?.name !== "string") continue;
      const token = normalizeToken(mention.name);
      if (token) tokens.add(token);
    }
  }

  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = INLINE_MENTION_REGEX.exec(message)) !== null) {
    const token = normalizeToken(inlineMatch[1] ?? "");
    if (token) tokens.add(token);
  }

  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = ROLE_PREFIX_REGEX.exec(message)) !== null) {
    const token = normalizeToken(prefixMatch[1] ?? "");
    if (token) tokens.add(token);
  }

  return [...tokens];
}

function uniqueByAgentId(values: ResolvedTargetAgent[]): ResolvedTargetAgent[] {
  const seen = new Set<string>();
  const out: ResolvedTargetAgent[] = [];
  for (const value of values) {
    if (seen.has(value.agentId)) continue;
    seen.add(value.agentId);
    out.push(value);
  }
  return out;
}

export function resolveMentionedAgents(
  mentionTokens: string[],
  agents: Agent[],
): ResolvedTargetAgent[] {
  if (mentionTokens.length === 0) return [];

  const agentIndex = agents.map((agent) => ({
    agent,
    keys: indexAgent(agent),
  }));

  const resolved: ResolvedTargetAgent[] = [];

  for (const token of mentionTokens) {
    const exact = agentIndex.filter((entry) => entry.keys.has(token));
    if (exact.length > 0) {
      resolved.push(...exact.map((entry) => ({ agentId: entry.agent.id, agentName: entry.agent.name })));
      continue;
    }

    // Optional fallback for user-friendly partial typing. Only allow when exactly one target is unambiguous.
    if (token.length >= 4) {
      const prefix = agentIndex.filter((entry) => {
        for (const key of entry.keys) {
          if (key.startsWith(token)) return true;
        }
        return false;
      });
      if (prefix.length === 1) {
        resolved.push({
          agentId: prefix[0]!.agent.id,
          agentName: prefix[0]!.agent.name,
        });
      }
    }
  }

  return uniqueByAgentId(resolved);
}

export function resolveRouting(message: string, mentions: SignalMention[] | undefined, agents: Agent[]): RoutingResolution {
  const mentionTokens = extractMentionTokens(message, mentions);
  const targets = resolveMentionedAgents(mentionTokens, agents);
  return { mentionTokens, targets };
}
