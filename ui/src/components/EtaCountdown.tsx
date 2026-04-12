import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatEta } from "../lib/eta";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface EtaCountdownProps {
  issueId: string;
  eta: Date | string | null | undefined;
  className?: string;
}

function formatChangeLogDate(date: Date | string): string {
  const d = new Date(date);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[d.getMonth()];
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 || 12;
  return `${month} ${day}, ${h12}:${minutes}${ampm}`;
}

function formatEtaValue(val: unknown): string {
  if (!val) return "none";
  try {
    const d = new Date(val as string);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = monthNames[d.getMonth()];
    const day = d.getDate();
    const hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    const h12 = hours % 12 || 12;
    return `${month} ${day}, ${h12}:${minutes}${ampm}`;
  } catch {
    return String(val);
  }
}

export function EtaCountdown({ issueId, eta, className }: EtaCountdownProps) {
  const [now, setNow] = useState(() => new Date());
  const prevEtaRef = useRef(eta);
  const [flash, setFlash] = useState(false);

  // Tick every 60 seconds
  useEffect(() => {
    if (!eta) return;
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, [eta]);

  // Flash when ETA changes server-side
  useEffect(() => {
    const prevStr = prevEtaRef.current ? new Date(prevEtaRef.current).toISOString() : null;
    const curStr = eta ? new Date(eta).toISOString() : null;
    if (prevStr !== curStr && prevEtaRef.current !== undefined) {
      setFlash(true);
      const timeout = setTimeout(() => setFlash(false), 1500);
      prevEtaRef.current = eta;
      return () => clearTimeout(timeout);
    }
    prevEtaRef.current = eta;
  }, [eta]);

  const { text, overdue } = formatEta(eta, now);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-default text-xs tabular-nums transition-colors",
            overdue && "text-red-600 dark:text-red-400 font-medium",
            !eta && "text-muted-foreground",
            flash && "animate-pulse bg-yellow-100/60 dark:bg-yellow-900/30 rounded px-1 -mx-1",
            className,
          )}
        >
          {text}
        </span>
      </TooltipTrigger>
      <EtaTooltipContent issueId={issueId} />
    </Tooltip>
  );
}

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
      if (details.eta !== undefined) return true;
      const prev = details._previous as Record<string, unknown> | null | undefined;
      return prev?.eta !== undefined;
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
          const prev = (details._previous as Record<string, unknown> | undefined)?.eta;
          const next = details.eta;
          const actor = event.actorType === "agent" ? (details.identifier ?? "Agent") : "User";
          return (
            <div key={event.id} className="text-xs leading-snug">
              <span className="text-muted-foreground">{formatChangeLogDate(event.createdAt)}</span>
              {" \u2014 "}
              <span className="font-medium">{String(actor)}</span>
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
