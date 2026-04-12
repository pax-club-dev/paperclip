import type { CycleTimeAnalytics } from "@paperclipai/shared";
import { ChartCard } from "./ActivityCharts";

function formatHours(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

function formatWeek(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

const priorityLabel: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function CycleTimeCharts({ analytics }: { analytics: CycleTimeAnalytics }) {
  const maxPriorityHours = Math.max(1, ...analytics.byPriority.map((row) => row.averageTotalHours));
  const maxTrendHours = Math.max(1, ...analytics.trend.map((row) => row.averageTotalHours));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard title="Cycle Time Summary" subtitle="Completed issues">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-border p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Completed</p>
            <p className="mt-1 text-lg font-semibold">{analytics.summary.completedIssueCount}</p>
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Avg Total</p>
            <p className="mt-1 text-lg font-semibold">{formatHours(analytics.summary.averageTotalHours)}</p>
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Avg Queue</p>
            <p className="mt-1 text-lg font-semibold">{formatHours(analytics.summary.averageQueueHours)}</p>
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Avg Work</p>
            <p className="mt-1 text-lg font-semibold">{formatHours(analytics.summary.averageWorkHours)}</p>
          </div>
        </div>
      </ChartCard>

      <ChartCard title="By Priority" subtitle="Queue vs work split">
        <div className="space-y-2">
          {analytics.byPriority.map((row) => {
            const queuePct = row.averageTotalHours > 0 ? (row.averageQueueHours / row.averageTotalHours) * 100 : 0;
            const totalWidth = (row.averageTotalHours / maxPriorityHours) * 100;
            return (
              <div key={row.priority}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span>
                    {priorityLabel[row.priority] ?? row.priority} ({row.issueCount})
                  </span>
                  <span className="text-muted-foreground">{formatHours(row.averageTotalHours)}</span>
                </div>
                <div className="h-2.5 rounded bg-muted/40">
                  <div className="flex h-full overflow-hidden rounded" style={{ width: `${totalWidth}%` }}>
                    <div className="bg-amber-500/90" style={{ width: `${queuePct}%` }} />
                    <div className="bg-emerald-500/90" style={{ width: `${100 - queuePct}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500/90" />Queue</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500/90" />Work</span>
        </div>
      </ChartCard>

      <ChartCard title="8-Week Trend" subtitle="Average total cycle time">
        <div className="flex h-24 items-end gap-1">
          {analytics.trend.map((point) => {
            const height = (point.averageTotalHours / maxTrendHours) * 100;
            return (
              <div key={point.weekStart} className="flex-1" title={`${point.weekStart}: ${formatHours(point.averageTotalHours)} (${point.issueCount} issues)`}>
                <div className="w-full rounded-sm bg-sky-500/80" style={{ height: `${Math.max(2, height)}%` }} />
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground">
          {analytics.trend.map((point) => (
            <div key={point.weekStart} className="flex-1 text-center">
              {formatWeek(point.weekStart)}
            </div>
          ))}
        </div>
      </ChartCard>

      <ChartCard title="By Agent" subtitle="Average total cycle time">
        {analytics.byAgent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No completed issues yet.</p>
        ) : (
          <div className="space-y-2">
            {analytics.byAgent.slice(0, 8).map((row) => (
              <div key={row.agentId ?? "unassigned"} className="flex items-center justify-between text-xs">
                <div className="truncate pr-2">
                  <span className="font-medium">{row.agentName ?? "Unassigned"}</span>
                  <span className="ml-1 text-muted-foreground">({row.issueCount})</span>
                </div>
                <span className="tabular-nums text-muted-foreground">{formatHours(row.averageTotalHours)}</span>
              </div>
            ))}
          </div>
        )}
      </ChartCard>
    </div>
  );
}
