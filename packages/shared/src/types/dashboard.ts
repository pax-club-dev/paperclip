export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}

export interface CycleTimeSummary {
  completedIssueCount: number;
  averageQueueHours: number;
  averageWorkHours: number;
  averageTotalHours: number;
}

export interface CycleTimePriorityBreakdown {
  priority: string;
  issueCount: number;
  averageQueueHours: number;
  averageWorkHours: number;
  averageTotalHours: number;
}

export interface CycleTimeAgentBreakdown {
  agentId: string | null;
  agentName: string | null;
  issueCount: number;
  averageQueueHours: number;
  averageWorkHours: number;
  averageTotalHours: number;
}

export interface CycleTimeTrendPoint {
  weekStart: string;
  issueCount: number;
  averageQueueHours: number;
  averageWorkHours: number;
  averageTotalHours: number;
}

export interface CycleTimeIssueBreakdown {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string;
  queueHours: number;
  workHours: number;
  totalHours: number;
}

export interface CycleTimeAnalytics {
  companyId: string;
  generatedAt: string;
  summary: CycleTimeSummary;
  byPriority: CycleTimePriorityBreakdown[];
  byAgent: CycleTimeAgentBreakdown[];
  trend: CycleTimeTrendPoint[];
  issues: CycleTimeIssueBreakdown[];
}
