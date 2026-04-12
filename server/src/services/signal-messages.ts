import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";

const SIGNAL_PLUGIN_KEY = "signal-bridge";
const MESSAGE_LOG_NAMESPACE = "message-log";

export function signalMessageService(db: Db) {
  async function resolvePluginId(): Promise<string | null> {
    const row = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.pluginKey, SIGNAL_PLUGIN_KEY))
      .then((rows) => rows[0] ?? null);

    return row?.id ?? null;
  }

  return {
    list: async (
      companyId: string,
      opts: { since?: string; limit?: number } = {},
    ) => {
      const pluginId = await resolvePluginId();
      if (pluginId === null) return [];

      const limit = Math.min(opts.limit ?? 50, 200);
      const conditions = [
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, companyId),
        eq(pluginState.namespace, MESSAGE_LOG_NAMESPACE),
      ];

      if (opts.since) {
        conditions.push(gte(pluginState.updatedAt, new Date(opts.since)));
      }

      const rows = await db
        .select({
          stateKey: pluginState.stateKey,
          value: pluginState.valueJson,
          updatedAt: pluginState.updatedAt,
        })
        .from(pluginState)
        .where(and(...conditions))
        .orderBy(desc(pluginState.updatedAt))
        .limit(limit);

      return rows.map((row) => {
        const value = row.value as Record<string, unknown>;
        return {
          id: row.stateKey,
          direction: value.direction as string,
          sender: value.sender as string,
          recipient: (value.recipient as string) ?? null,
          content: value.content as string,
          signalTimestamp: (value.signalTimestamp as number) ?? null,
          routedToAgentId: (value.routedToAgentId as string) ?? null,
          createdAt: (value.createdAt as string) ?? row.updatedAt.toISOString(),
