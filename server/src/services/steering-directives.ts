import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { steeringDirectives } from "@paperclipai/db";

export type SteeringDirective = typeof steeringDirectives.$inferSelect;
type InsertDirective = typeof steeringDirectives.$inferInsert;

/**
 * Compose directives for a heartbeat context.
 *
 * Loads all active directives that apply to the given scope chain
 * (company → project → agent → issue) and returns them sorted
 * by scope order then priority within each scope.
 */
export async function composeDirectives(
  db: Pick<Db, "select">,
  opts: {
    companyId: string;
    projectId?: string | null;
    agentId?: string | null;
    issueId?: string | null;
  },
): Promise<SteeringDirective[]> {
  const scopeFilters: Array<{ scope: string; scopeId: string }> = [
    { scope: "company", scopeId: opts.companyId },
  ];
  if (opts.projectId) {
    scopeFilters.push({ scope: "project", scopeId: opts.projectId });
  }
  if (opts.agentId) {
    scopeFilters.push({ scope: "agent", scopeId: opts.agentId });
  }
  if (opts.issueId) {
    scopeFilters.push({ scope: "issue", scopeId: opts.issueId });
  }

  const scopeIds = scopeFilters.map((f) => f.scopeId);
  const scopes = scopeFilters.map((f) => f.scope);

  const rows = await db
    .select()
    .from(steeringDirectives)
    .where(
      and(
        eq(steeringDirectives.companyId, opts.companyId),
        eq(steeringDirectives.active, true),
        inArray(steeringDirectives.scopeId, scopeIds),
        inArray(steeringDirectives.scope, scopes),
      ),
    )
    .orderBy(asc(steeringDirectives.priority));

  // Sort by scope order: company → project → agent → issue
  const scopeOrder: Record<string, number> = { company: 0, project: 1, agent: 2, issue: 3 };
  rows.sort((a, b) => {
    const orderDiff = (scopeOrder[a.scope] ?? 99) - (scopeOrder[b.scope] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    return a.priority - b.priority;
  });

  return rows;
}

/**
 * Format composed directives as a single markdown string
 * suitable for injection into agent context.
 */
export function formatDirectivesAsMarkdown(directives: SteeringDirective[]): string {
  if (directives.length === 0) return "";

  const lines: string[] = ["## Steering Directives\n"];
  let lastScope = "";

  for (const d of directives) {
    if (d.scope !== lastScope) {
      lines.push(`### ${d.scope.charAt(0).toUpperCase() + d.scope.slice(1)}-level\n`);
      lastScope = d.scope;
    }
    lines.push(`**${d.key}**: ${d.content}\n`);
  }

  return lines.join("\n");
}

export function steeringDirectiveService(db: Db) {
  return {
    list: (companyId: string, scope?: string, scopeId?: string) => {
      if (scope && scopeId) {
        return db
          .select()
          .from(steeringDirectives)
          .where(
            and(
              eq(steeringDirectives.companyId, companyId),
              eq(steeringDirectives.scope, scope),
              eq(steeringDirectives.scopeId, scopeId),
            ),
          )
          .orderBy(asc(steeringDirectives.priority));
      }
      return db
        .select()
        .from(steeringDirectives)
        .where(eq(steeringDirectives.companyId, companyId))
        .orderBy(asc(steeringDirectives.scope), asc(steeringDirectives.priority));
    },

    getById: (id: string) =>
      db
        .select()
        .from(steeringDirectives)
        .where(eq(steeringDirectives.id, id))
        .then((rows) => rows[0] ?? null),

    create: (data: InsertDirective) =>
      db
        .insert(steeringDirectives)
        .values(data)
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<InsertDirective>) =>
      db
        .update(steeringDirectives)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(steeringDirectives.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(steeringDirectives)
        .where(eq(steeringDirectives.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    compose: (opts: {
      companyId: string;
      projectId?: string | null;
      agentId?: string | null;
      issueId?: string | null;
    }) => composeDirectives(db, opts),

    formatAsMarkdown: formatDirectivesAsMarkdown,
  };
}
