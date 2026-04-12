import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface EtaCountdownProps {
  issueId: string;
  etaAt: Date | string | null;
  className?: string;
}

// ── Formatting helpers ──────────────────────────────────────────────

function formatEta(remainingMs: number): string {
  const abs = Math.abs(remainingMs);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    const date = new Date(Date.now() + remainingMs);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (days >= 1) return `${days}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

type EtaState = "plenty" | "approaching" | "overdue";

function getEtaState(remainingMs: number): EtaState {
  if (remainingMs <= 0) return "overdue";
  if (remainingMs < 3_600_000) return "approaching";
  return "plenty";
}

const stateStyles: Record<EtaState, string> = {
  plenty: "text-green-600 dark:text-green-400",
  approaching: "text-yellow-600 dark:text-yellow-400",
  overdue: "text-red-600 dark:text-red-400",
};

function formatChangeLogDate(date: Date | string): string {
  const d = new Date(date);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getHours() % 12 || 12;
  const min = d.getMinutes().toString().padStart(2, "0");
  const ampm = d.getHours() >= 12 ? "pm" : "am";
  return `${monthNames[d.getMonth()]} ${d.getDate()}, ${h}:${min}${ampm}`;
}

function formatEtaValue(val: unknown): string {
  if (!val) return "none";
  try {
    const d = new Date(val as string);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const h = d.getHours() % 12 || 12;
    const min = d.getMinutes().toString().padStart(2, "0");
    const ampm = d.getHours() >= 12 ? "pm" : "am";
    return `${monthNames[d.getMonth()]} ${d.getDate()}, ${h}:${min}${ampm}`;
  } catch {
    return String(val);
  }
}

// ── Main component ──────────────────────────────────────────────────

export function EtaCountdown({ issueId, etaAt, className }: EtaCountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  const prevEtaRef = useRef(etaAt);
  const [flash, setFlash] = useState(false);

  // Tick every 60s
  useEffect(() => {
    if (!etaAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [etaAt]);

  // Flash when ETA changes server-side
  useEffect(() => {
    const prevStr = prevEtaRef.current ? new Date(prevEtaRef.current).toISOString() : null;
    const curStr = etaAt ? new Date(etaAt).toISOString() : null;
    if (prevStr !== curStr && prevEtaRef.current !== undefined) {
      setFlash(true);
      const timeout = setTimeout(() => setFlash(false), 1500);
      prevEtaRef.current = etaAt;
      return () => clearTimeout(timeout);
    }
    prevEtaRef.current = etaAt;
  }, [etaAt]);

  if (!etaAt) {
    return <span className={cn("text-xs text-muted-foreground", className)}>{"\u2014"}</span>;
  }

  const etaMs = new Date(etaAt).getTime();
  const remainingMs = etaMs - now;
  const state = getEtaState(remainingMs);
  const formatted = formatEta(remainingMs);
  const label = state === "overdue" ? `${formatted} overdue` : formatted;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-default font-mono text-xs tabular-nums",
            stateStyles[state],
            flash && "animate-pulse bg-yellow-100/60 dark:bg-yellow-900/30 rounded px-1 -mx-1",
            className,
          )}
        >
          {label}
        </span>
      </TooltipTrigger>
      <EtaTooltipContent issueId={issueId} />
    </Tooltip>
  );
}

// ── Tooltip with ETA change log ─────────────────────────────────────

function EtaTooltipContent({ issueId }: { issueId: string }) {
  const { selectedCompanyId } = useCompany();
  const { data: activity } = useQuery({
    queryKey: [...queryKeys.issues.activity(issueId), "eta-changes"],
    queryFn: () => activityApi.forIssue(issueId),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const etaChanges = (activity ?? [])
    .filter((event) => {
      if (event.action !== "issue.updated") return false;
      const details = event.details as Record<string, unknown> | null;
      if (!details) return false;
      if (details.etaAt !== undefined) return true;
      const prev = details._previous as Record<string, unknown> | null | undefined;
      return prev?.etaAt !== undefined;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  if (etaChanges.length === 0) {
    return (
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="text-xs text-muted-foreground">No ETA changes recorded</p>
      </TooltipContent>
    );
  }

  return (
    <TooltipContent side="bottom" className="max-w-sm p-2">
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {etaChanges.map((event) => {
          const details = event.details as Record<string, unknown>;
          const prev = (details._previous as Record<string, unknown> | undefined)?.etaAt;
          const next = details.etaAt;
          const actor =
            event.actorType === "agent" ? ((details.identifier as string) ?? "Agent") : "User";
          return (
            <div key={event.id} className="text-xs leading-snug">
              <span className="text-muted-foreground">{formatChangeLogDate(event.createdAt)}</span>
              {" \u2014 "}
              <span className="font-medium">{actor}</span>
              {" set ETA to "}
              <span className="font-medium">{formatEtaValue(next)}</span>
              {prev !== undefined && (
                <span className="text-muted-foreground"> (was {formatEtaValue(prev)})</span>
              )}
            </div>
          );
        })}
      </div>
    </TooltipContent>
  );
}
