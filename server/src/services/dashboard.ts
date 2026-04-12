import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, issues } from "@paperclipai/db";
import type { CycleTimeIssueBreakdown, CycleTimeTrendPoint } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const ONE_HOUR_MS = 1000 * 60 * 60;
const PRIORITY_ORDER = ["critical", "high", "medium", "low"] as const;

function roundHours(hours: number): number {
  return Number(hours.toFixed(2));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weekStartUtc(date: Date): Date {
  const day = date.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return start;
}

function computeDurations(createdAt: Date, startedAt: Date | null, completedAt: Date): {
  queueHours: number;
  workHours: number;
  totalHours: number;
} {
  const createdMs = createdAt.getTime();
  const startedMs = startedAt?.getTime() ?? null;
  const completedMs = completedAt.getTime();
  const queueEndMs = startedMs ?? completedMs;
  const queueHours = Math.max(0, (queueEndMs - createdMs) / ONE_HOUR_MS);
  const workHours = startedMs === null ? 0 : Math.max(0, (completedMs - startedMs) / ONE_HOUR_MS);
  const totalHours = Math.max(0, (completedMs - createdMs) / ONE_HOUR_MS);
  return { queueHours, workHours, totalHours };
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
      };
    },
    cycleTimes: async (companyId: string) => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const rows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeName: agents.name,
          createdAt: issues.createdAt,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            sql`${issues.completedAt} is not null`,
          ),
        );

      const issueMetrics: CycleTimeIssueBreakdown[] = rows
        .filter((row): row is typeof row & { completedAt: Date } => row.completedAt !== null)
        .map((row) => {
          const durations = computeDurations(row.createdAt, row.startedAt, row.completedAt);
          return {
            issueId: row.id,
            identifier: row.identifier,
            title: row.title,
            priority: row.priority,
            assigneeAgentId: row.assigneeAgentId,
            assigneeName: row.assigneeName,
            createdAt: row.createdAt.toISOString(),
            startedAt: row.startedAt?.toISOString() ?? null,
            completedAt: row.completedAt.toISOString(),
            queueHours: roundHours(durations.queueHours),
            workHours: roundHours(durations.workHours),
            totalHours: roundHours(durations.totalHours),
          };
        });

      const summary = {
        completedIssueCount: issueMetrics.length,
        averageQueueHours: roundHours(average(issueMetrics.map((item) => item.queueHours))),
        averageWorkHours: roundHours(average(issueMetrics.map((item) => item.workHours))),
        averageTotalHours: roundHours(average(issueMetrics.map((item) => item.totalHours))),
      };

      const byPriority = PRIORITY_ORDER.map((priority) => {
        const scoped = issueMetrics.filter((item) => item.priority === priority);
        return {
          priority,
          issueCount: scoped.length,
          averageQueueHours: roundHours(average(scoped.map((item) => item.queueHours))),
          averageWorkHours: roundHours(average(scoped.map((item) => item.workHours))),
          averageTotalHours: roundHours(average(scoped.map((item) => item.totalHours))),
        };
      });

      const byAgentMap = new Map<string, { agentId: string | null; agentName: string | null; items: CycleTimeIssueBreakdown[] }>();
      for (const item of issueMetrics) {
        const key = item.assigneeAgentId ?? "unassigned";
        if (!byAgentMap.has(key)) {
          byAgentMap.set(key, {
            agentId: item.assigneeAgentId,
            agentName: item.assigneeName,
            items: [],
          });
        }
        byAgentMap.get(key)!.items.push(item);
      }

      const byAgent = Array.from(byAgentMap.values())
        .map((entry) => ({
          agentId: entry.agentId,
          agentName: entry.agentName,
          issueCount: entry.items.length,
          averageQueueHours: roundHours(average(entry.items.map((item) => item.queueHours))),
          averageWorkHours: roundHours(average(entry.items.map((item) => item.workHours))),
          averageTotalHours: roundHours(average(entry.items.map((item) => item.totalHours))),
        }))
        .sort((a, b) => b.issueCount - a.issueCount || b.averageTotalHours - a.averageTotalHours);

      const now = new Date();
      const currentWeekStart = weekStartUtc(now);
      const trendSeed = new Map<string, { queue: number[]; work: number[]; total: number[] }>();
      for (let offset = 7; offset >= 0; offset--) {
        const week = new Date(currentWeekStart);
        week.setUTCDate(week.getUTCDate() - (offset * 7));
        trendSeed.set(week.toISOString().slice(0, 10), { queue: [], work: [], total: [] });
      }

      for (const item of issueMetrics) {
        const weekStart = weekStartUtc(new Date(item.completedAt)).toISOString().slice(0, 10);
        const bucket = trendSeed.get(weekStart);
        if (!bucket) continue;
        bucket.queue.push(item.queueHours);
        bucket.work.push(item.workHours);
        bucket.total.push(item.totalHours);
      }

      const trend: CycleTimeTrendPoint[] = Array.from(trendSeed.entries()).map(([weekStart, bucket]) => ({
        weekStart,
        issueCount: bucket.total.length,
        averageQueueHours: roundHours(average(bucket.queue)),
        averageWorkHours: roundHours(average(bucket.work)),
        averageTotalHours: roundHours(average(bucket.total)),
      }));

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        summary,
        byPriority,
        byAgent,
        trend,
        issues: issueMetrics.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()),
      };
    },
  };
}
