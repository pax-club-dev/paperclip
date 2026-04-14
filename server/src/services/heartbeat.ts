import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { BillingType, ExecutionWorkspace, ExecutionWorkspaceConfig } from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, UsageSummary } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { costService } from "./costs.js";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { buildHeartbeatRunIssueComment, summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService, mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";
import { quotaHealthService } from "./quota-health.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 3;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INLINE_WAKE_COMMENTS = 8;
const MAX_INLINE_WAKE_COMMENT_BODY_CHARS = 4_000;
const MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS = 12_000;
const execFile = promisify(execFileCallback);
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export function applyPersistedExecutionWorkspaceConfig(input: {
  config: Record<string, unknown>;
  workspaceConfig: ExecutionWorkspaceConfig | null;
  mode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const nextConfig = { ...input.config };

  if (input.mode !== "agent_default") {
    if (input.workspaceConfig?.workspaceRuntime === null) {
      delete nextConfig.workspaceRuntime;
    } else if (input.workspaceConfig?.workspaceRuntime) {
      nextConfig.workspaceRuntime = { ...input.workspaceConfig.workspaceRuntime };
    }
  }

  if (input.workspaceConfig && input.mode === "isolated_workspace") {
    const nextStrategy = parseObject(nextConfig.workspaceStrategy);
    if (input.workspaceConfig.provisionCommand === null) delete nextStrategy.provisionCommand;
    else nextStrategy.provisionCommand = input.workspaceConfig.provisionCommand;
    if (input.workspaceConfig.teardownCommand === null) delete nextStrategy.teardownCommand;
    else nextStrategy.teardownCommand = input.workspaceConfig.teardownCommand;
    nextConfig.workspaceStrategy = nextStrategy;
  }

  return nextConfig;
}

export function stripWorkspaceRuntimeFromExecutionRunConfig(config: Record<string, unknown>) {
  const nextConfig = { ...config };
  delete nextConfig.workspaceRuntime;
  return nextConfig;
}

export function buildRealizedExecutionWorkspaceFromPersisted(input: {
  base: ExecutionWorkspaceInput;
  workspace: ExecutionWorkspace;
}): RealizedExecutionWorkspace | null {
  const cwd = readNonEmptyString(input.workspace.cwd) ?? readNonEmptyString(input.workspace.providerRef);
  if (!cwd) {
    return null;
  }

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  return {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (readNonEmptyString(input.workspace.providerRef) ?? cwd) : null,
    warnings: [],
    created: false,
  };
}

function buildExecutionWorkspaceConfigSnapshot(config: Record<string, unknown>): Partial<ExecutionWorkspaceConfig> | null {
  const strategy = parseObject(config.workspaceStrategy);
  const snapshot: Partial<ExecutionWorkspaceConfig> = {};

  if ("workspaceStrategy" in config) {
    snapshot.provisionCommand = typeof strategy.provisionCommand === "string" ? strategy.provisionCommand : null;
    snapshot.teardownCommand = typeof strategy.teardownCommand === "string" ? strategy.teardownCommand : null;
  }

  if ("workspaceRuntime" in config) {
    const workspaceRuntime = parseObject(config.workspaceRuntime);
    snapshot.workspaceRuntime = Object.keys(workspaceRuntime).length > 0 ? workspaceRuntime : null;
  }

  const hasSnapshot = Object.values(snapshot).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
  return hasSnapshot ? snapshot : null;
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

/**
 * Synthetic task key for timer/heartbeat wakes that have no issue context.
 * This allows timer wakes to participate in the `agentTaskSessions` system
 * and benefit from robust session resume, instead of relying solely on the
 * simpler `agentRuntimeState.sessionId` fallback.
 */
const HEARTBEAT_TASK_KEY = "__heartbeat__";

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

/**
 * Extended task key derivation that falls back to a stable synthetic key
 * for timer/heartbeat wakes. This ensures timer wakes can resume their
 * previous session via `agentTaskSessions` instead of starting fresh.
 *
 * The synthetic key is only used when:
 * - No explicit task/issue key exists in the context
 * - The wake source is "timer" (scheduled heartbeat)
 */
export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return HEARTBEAT_TASK_KEY;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function mergeWakeCommentIds(...values: Array<unknown>): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) append(entry);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const candidate = value as Record<string, unknown>;
      const batched = extractWakeCommentIds(candidate);
      if (batched.length > 0) {
        for (const entry of batched) append(entry);
        continue;
      }
      append(candidate.wakeCommentId);
      append(candidate.commentId);
      continue;
    }
    append(value);
  }

  return merged;
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);
  const wakeCommentIds = mergeWakeCommentIds(contextSnapshot, commentIdFromPayload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (wakeCommentIds.length > 0) {
    const latestCommentId = wakeCommentIds[wakeCommentIds.length - 1];
    contextSnapshot[WAKE_COMMENT_IDS_KEY] = wakeCommentIds;
    contextSnapshot.commentId = latestCommentId;
    contextSnapshot.wakeCommentId = latestCommentId;
    // Once comment ids are normalized into the snapshot, rebuild the structured
    // wake payload from those ids later instead of carrying forward stale data.
    delete contextSnapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  } else if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }
  // Plugin session messages (e.g. Signal) pass the user's message text via
  // payload.prompt.  Carry it forward in the snapshot so that the adapter can
  // surface it even when there are no issue comments to render.
  const promptFromPayload = readNonEmptyString(payload?.["prompt"]);
  if (promptFromPayload && !readNonEmptyString(contextSnapshot["prompt"])) {
    contextSnapshot.prompt = promptFromPayload;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const mergedCommentIds = mergeWakeCommentIds(existing, incoming);
  if (mergedCommentIds.length > 0) {
    const latestCommentId = mergedCommentIds[mergedCommentIds.length - 1];
    merged[WAKE_COMMENT_IDS_KEY] = mergedCommentIds;
    merged.commentId = latestCommentId;
    merged.wakeCommentId = latestCommentId;
    // The merged context should carry canonical comment ids; the next wake will
    // regenerate any structured payload from those ids.
    delete merged[PAPERCLIP_WAKE_PAYLOAD_KEY];
  }
  return merged;
}

/**
 * Remove already-promoted comment IDs from a deferred wake context snapshot.
 * Returns true if the snapshot was modified.
 */
export function stripPromotedCommentIdsFromSnapshot(
  snapshot: Record<string, unknown>,
  promotedIds: ReadonlySet<string>,
): boolean {
  const ids = extractWakeCommentIds(snapshot);
  if (ids.length === 0) return false;
  const filtered = ids.filter((id) => !promotedIds.has(id));
  if (filtered.length === ids.length) return false;
  if (filtered.length > 0) {
    snapshot[WAKE_COMMENT_IDS_KEY] = filtered;
    snapshot.commentId = filtered[filtered.length - 1];
    snapshot.wakeCommentId = filtered[filtered.length - 1];
  } else {
    delete snapshot[WAKE_COMMENT_IDS_KEY];
    delete snapshot.commentId;
    delete snapshot.wakeCommentId;
  }
  return true;
}

async function buildPaperclipWakePayload(input: {
  db: Db;
  companyId: string;
  contextSnapshot: Record<string, unknown>;
  issueSummary?:
    | {
        id: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
      }
    | null;
}) {
  const commentIds = extractWakeCommentIds(input.contextSnapshot);
  if (commentIds.length === 0) return null;

  const issueId = readNonEmptyString(input.contextSnapshot.issueId);
  const issueSummary =
    input.issueSummary ??
    (issueId
      ? await input.db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null);

  const commentRows = await input.db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      body: issueComments.body,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        inArray(issueComments.id, commentIds),
      ),
    );

  const commentsById = new Map(commentRows.map((comment) => [comment.id, comment]));
  const comments: Array<Record<string, unknown>> = [];
  let remainingBodyChars = MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS;
  let truncated = false;
  let missingCommentCount = 0;

  for (const commentId of commentIds) {
    const row = commentsById.get(commentId);
    if (!row) {
      truncated = true;
      missingCommentCount += 1;
      continue;
    }
    if (comments.length >= MAX_INLINE_WAKE_COMMENTS) {
      truncated = true;
      break;
    }

    const fullBody = row.body;
    const allowedBodyChars = Math.min(MAX_INLINE_WAKE_COMMENT_BODY_CHARS, remainingBodyChars);
    if (allowedBodyChars <= 0) {
      truncated = true;
      break;
    }

    const body = fullBody.length > allowedBodyChars ? fullBody.slice(0, allowedBodyChars) : fullBody;
    const bodyTruncated = body.length < fullBody.length;
    if (bodyTruncated) truncated = true;
    remainingBodyChars -= body.length;

    comments.push({
      id: row.id,
      issueId: row.issueId,
      body,
      bodyTruncated,
      createdAt: row.createdAt.toISOString(),
      author: row.authorAgentId
        ? { type: "agent", id: row.authorAgentId }
        : row.authorUserId
          ? { type: "user", id: row.authorUserId }
          : { type: "system", id: null },
    });
  }

  return {
    reason: readNonEmptyString(input.contextSnapshot.wakeReason),
    issue: issueSummary
      ? {
          id: issueSummary.id,
          identifier: issueSummary.identifier,
          title: issueSummary.title,
          status: issueSummary.status,
          priority: issueSummary.priority,
        }
      : null,
    commentIds,
    latestCommentId: commentIds[commentIds.length - 1] ?? null,
    comments,
    commentWindow: {
      requestedCount: commentIds.length,
      includedCount: comments.length,
      missingCount: missingCommentCount,
    },
    truncated,
    fallbackFetchNeeded: truncated || missingCommentCount > 0,
  };
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const quotaHealth = quotaHealthService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, resumeTaskKey)
      : null;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId: readNonEmptyString(resumeContext.taskId) ?? readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        projectId: workspaceProjectId,
        repoUrl: null,
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    };

    const queued = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "process_lost_retry",
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return retryRun;
    });

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued automatic retry after orphaned child process was confirmed dead",
      payload: {
        retryOfRunId: run.id,
      },
    });

    return queued;
  }

  // ---------------------------------------------------------------------------
  // Dispatch source metrics — PAX-2177
  // ---------------------------------------------------------------------------
  const dispatchMetrics = { eventSourced: 0, timerSourced: 0, lastReportedAt: Date.now() };
  function trackDispatchSource(source: string) {
    if (source === "timer") dispatchMetrics.timerSourced++;
    else dispatchMetrics.eventSourced++;
    const now = Date.now();
    if (now - dispatchMetrics.lastReportedAt >= 30 * 60 * 1000) {
      const total = dispatchMetrics.eventSourced + dispatchMetrics.timerSourced;
      const pct = total > 0 ? Math.round((dispatchMetrics.eventSourced / total) * 100) : 0;
      logger.info(
        { eventSourced: dispatchMetrics.eventSourced, timerSourced: dispatchMetrics.timerSourced, eventDrivenPct: pct },
        `dag_dispatch: ${dispatchMetrics.eventSourced} event-sourced, ${dispatchMetrics.timerSourced} timer-sourced (${pct}% event-driven)`,
      );
      dispatchMetrics.eventSourced = 0;
      dispatchMetrics.timerSourced = 0;
      dispatchMetrics.lastReportedAt = now;
    }
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    const intervalSec = Math.max(0, asNumber(heartbeat.intervalSec, 0));
    const fallbackIntervalSec = Math.max(
      0,
      asNumber(heartbeat.fallbackIntervalSec, intervalSec > 0 ? intervalSec * 3 : 0),
    );

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec,
      fallbackIntervalSec,
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  // ---------------------------------------------------------------------------
  // Resilience: only count runs this process is actually managing, OR runs
  // younger than MAX_RUN_AGE_FOR_CAPACITY_MS.  Orphaned "running" DB rows
  // (from crashes, killed processes, or runaway loops) cannot block dispatch
  // longer than this threshold.  reapOrphanedRuns will clean them up; this
  // ensures capacity isn't held hostage while waiting for the reaper.
  // ---------------------------------------------------------------------------
  const MAX_RUN_AGE_FOR_CAPACITY_MS = 10 * 60 * 1000; // 10 minutes

  async function countRunningRunsForAgent(agentId: string) {
    const runs = await db
      .select({ id: heartbeatRuns.id, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));

    const now = Date.now();
    let count = 0;
    for (const run of runs) {
      // Always count runs this process is actively managing
      if (activeRunExecutions.has(run.id)) { count++; continue; }
      // Count DB-only runs if they're recent enough to plausibly be real
      const age = run.startedAt ? now - new Date(run.startedAt).getTime() : Infinity;
      if (age < MAX_RUN_AGE_FOR_CAPACITY_MS) { count++; continue; }
      // Stale orphan — don't count against capacity
      logger.debug({ runId: run.id, agentId, ageMs: age }, "countRunningRunsForAgent: ignoring stale orphan");
    }
    return count;
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const contextIssueId = readNonEmptyString(context.issueId);
    if (contextIssueId) {
      const [targetIssue] = await db
        .select({ status: issues.status, identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, contextIssueId));
      if (targetIssue && (targetIssue.status === "done" || targetIssue.status === "cancelled")) {
        // Inlined cancel: we're inside withAgentStartLock(run.agentId); cancelRunInternal
        // re-enters that lock via startNextQueuedRunForAgent and would deadlock. The caller
        // loop in startNextQueuedRunForAgent continues iterating queued runs for this agent.
        const reason = `Target issue ${targetIssue.identifier ?? contextIssueId} is already ${targetIssue.status}; skipping run`;
        const finishedAt = new Date();
        const cancelled = await setRunStatus(run.id, "cancelled", {
          finishedAt,
          error: reason,
          errorCode: "cancelled",
        });
        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt,
          error: reason,
        });
        if (cancelled) {
          await appendRunEvent(cancelled, 1, {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message: "run cancelled",
          });
          await releaseIssueExecutionAndPromote(cancelled);
        }
        return null;
      }
    }

    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId: contextIssueId,
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const isFirstHeartbeat = !existing.lastHeartbeatAt;

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (isFirstHeartbeat && updated) {
      const tc = getTelemetryClient();
      if (tc) trackAgentFirstHeartbeat(tc, { agentRole: updated.role });
    }

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }

    if (nextStatus === "idle") {
      await autoWakeIdleAgentIfAssignableWork(agentId).catch((err) => {
        // Query-level errors (type mismatches, missing columns) are bugs, not
        // transient failures.  Log at ERROR so they're impossible to miss.
        const isQueryBug = err?.code && /^42/.test(String(err.code)); // PG class 42 = syntax/type errors
        const level = isQueryBug ? "error" : "warn";
        logger[level](
          { err, agentId, pgCode: err?.code, message: err?.message },
          `dag_dispatch: autoWakeIdleAgentIfAssignableWork failed${isQueryBug ? " — QUERY BUG, dispatch is broken until fixed" : ""}`,
        );
      });
    }
  }

  // ---------------------------------------------------------------------------
  // DAG-aware dispatch — PAX-2177
  // ---------------------------------------------------------------------------

  const PRIORITY_SCORES: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const DAG_TERMINAL_STATUSES = new Set(["done", "cancelled"]);

  interface CompanyBlockingGraph {
    blockerToBlocked: Map<string, string[]>;
    fanOut: Map<string, number>;
    criticalPathDepth: Map<string, number>;
  }

  async function computeCompanyBlockingGraph(companyId: string): Promise<CompanyBlockingGraph> {
    const edges = await db
      .select({ blockerId: issueRelations.issueId, blockedId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const blockerToBlocked = new Map<string, string[]>();
    if (edges.length === 0) return { blockerToBlocked, fanOut: new Map(), criticalPathDepth: new Map() };

    const allIds = new Set<string>();
    for (const e of edges) { allIds.add(e.blockerId); allIds.add(e.blockedId); }
    const meta = await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, [...allIds]));
    const statusMap = new Map(meta.map((i) => [i.id, i.status]));

    for (const e of edges) {
      if (DAG_TERMINAL_STATUSES.has(statusMap.get(e.blockerId) ?? "")) continue;
      if (DAG_TERMINAL_STATUSES.has(statusMap.get(e.blockedId) ?? "")) continue;
      const fwd = blockerToBlocked.get(e.blockerId) ?? [];
      fwd.push(e.blockedId);
      blockerToBlocked.set(e.blockerId, fwd);
    }

    const fanOut = new Map<string, number>();
    for (const root of blockerToBlocked.keys()) {
      const visited = new Set<string>();
      const q = [...(blockerToBlocked.get(root) ?? [])];
      while (q.length > 0) { const c = q.shift()!; if (visited.has(c)) continue; visited.add(c); q.push(...(blockerToBlocked.get(c) ?? [])); }
      fanOut.set(root, visited.size);
    }

    const criticalPathDepth = new Map<string, number>();
    function dfs(n: string, visiting: Set<string>): number {
      if (criticalPathDepth.has(n)) return criticalPathDepth.get(n)!;
      if (visiting.has(n)) return 0;
      visiting.add(n);
      let max = 0;
      for (const c of blockerToBlocked.get(n) ?? []) max = Math.max(max, 1 + dfs(c, visiting));
      visiting.delete(n);
      criticalPathDepth.set(n, max);
      return max;
    }
    for (const n of blockerToBlocked.keys()) if (!criticalPathDepth.has(n)) dfs(n, new Set());

    return { blockerToBlocked, fanOut, criticalPathDepth };
  }

  interface RankedIssue { issueId: string; priority: string; priorityScore: number; fanOut: number; criticalPathDepth: number; createdAt: Date; }

  async function rankReadyIssuesForAgent(agentId: string): Promise<RankedIssue[]> {
    const agent = await getAgent(agentId);
    if (!agent) return [];

    // Find unblocked, unlocked todo issues with NO active heartbeat run already targeting them.
    // The extra NOT EXISTS on heartbeat_runs prevents the runaway re-enqueue loop where
    // a completed run releases the execution lock and the issue gets re-picked immediately.
    const candidates = await db
      .select({ id: issues.id, priority: issues.priority, companyId: issues.companyId, createdAt: issues.createdAt })
      .from(issues)
      .where(
        and(
          eq(issues.assigneeAgentId, agentId),
          eq(issues.status, "todo"),
          sql`${issues.executionRunId} IS NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${issueRelations} r
            INNER JOIN ${issues} b ON b.id = r.issue_id
            WHERE r.related_issue_id = ${issues.id}
              AND r.type = 'blocks'
              AND b.status NOT IN ('done', 'cancelled')
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${heartbeatRuns} hr
            WHERE hr.agent_id = ${agentId}
              AND hr.status IN ('queued', 'running')
              AND hr.context_snapshot ->> 'issueId' = ${issues.id}::text
          )`,
        ),
      );

    if (candidates.length === 0) return [];
    if (candidates.length === 1) {
      const c = candidates[0];
      return [{ issueId: c.id, priority: c.priority, priorityScore: PRIORITY_SCORES[c.priority] ?? 4, fanOut: 0, criticalPathDepth: 0, createdAt: new Date(c.createdAt) }];
    }

    const graph = await computeCompanyBlockingGraph(agent.companyId);
    const ranked: RankedIssue[] = candidates.map((c) => ({
      issueId: c.id, priority: c.priority, priorityScore: PRIORITY_SCORES[c.priority] ?? 4,
      fanOut: graph.fanOut.get(c.id) ?? 0, criticalPathDepth: graph.criticalPathDepth.get(c.id) ?? 0,
      createdAt: new Date(c.createdAt),
    }));
    ranked.sort((a, b) => {
      if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
      if (a.fanOut !== b.fanOut) return b.fanOut - a.fanOut;
      if (a.criticalPathDepth !== b.criticalPathDepth) return b.criticalPathDepth - a.criticalPathDepth;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return ranked;
  }

  async function rankQueuedRunsByDagPriority(
    queuedRuns: Array<typeof heartbeatRuns.$inferSelect>,
  ): Promise<Array<typeof heartbeatRuns.$inferSelect>> {
    if (queuedRuns.length <= 1) return queuedRuns;

    const runIssueIds = new Map<string, string>();
    const companyIds = new Set<string>();
    for (const run of queuedRuns) {
      const ctx = parseObject(run.contextSnapshot);
      const iid = readNonEmptyString(ctx.issueId);
      if (iid) runIssueIds.set(run.id, iid);
      companyIds.add(run.companyId);
    }
    if (runIssueIds.size === 0) return queuedRuns;

    const iids = [...new Set(runIssueIds.values())];
    const meta = await db.select({ id: issues.id, priority: issues.priority, companyId: issues.companyId }).from(issues).where(inArray(issues.id, iids));
    const issueById = new Map(meta.map((i) => [i.id, i]));

    const graphs = new Map<string, CompanyBlockingGraph>();
    for (const cid of companyIds) graphs.set(cid, await computeCompanyBlockingGraph(cid));

    const scored = queuedRuns.map((run) => {
      const iid = runIssueIds.get(run.id);
      const issue = iid ? issueById.get(iid) : null;
      const g = issue ? graphs.get(issue.companyId) : null;
      return {
        run,
        ps: issue ? (PRIORITY_SCORES[issue.priority] ?? 4) : 5,
        fo: g?.fanOut.get(iid!) ?? 0,
        cp: g?.criticalPathDepth.get(iid!) ?? 0,
        ca: run.createdAt ? new Date(run.createdAt).getTime() : Date.now(),
      };
    });
    scored.sort((a, b) => (a.ps - b.ps) || (b.fo - a.fo) || (b.cp - a.cp) || (a.ca - b.ca));
    return scored.map((s) => s.run);
  }

  // ---------------------------------------------------------------------------
  // Idle agent dispatch: when an agent becomes idle, find ALL unblocked ready
  // issues using DAG ranking and enqueue wakeups in parallel (up to available
  // slots). The NOT EXISTS check on heartbeat_runs prevents re-enqueuing issues
  // that already have an active run, closing the runaway loop.  PAX-2177.
  //
  // Resilience: per-agent cooldown prevents the tight re-dispatch loop where
  // run-complete → dispatch → run-complete → dispatch fires every few seconds.
  // Even if the dedup guard fails, the cooldown caps the damage rate.
  // ---------------------------------------------------------------------------
  const MIN_DISPATCH_INTERVAL_MS = 5_000; // 5 seconds between dispatch batches per agent
  const lastDispatchAt = new Map<string, number>();

  async function autoWakeIdleAgentIfAssignableWork(agentId: string) {
    const now = Date.now();
    const lastAt = lastDispatchAt.get(agentId) ?? 0;
    if (now - lastAt < MIN_DISPATCH_INTERVAL_MS) {
      logger.debug({ agentId, cooldownMs: MIN_DISPATCH_INTERVAL_MS - (now - lastAt) }, "dag_dispatch: skipping, cooldown active");
      return;
    }

    const ranked = await rankReadyIssuesForAgent(agentId);
    if (ranked.length === 0) return;

    const agent = await getAgent(agentId);
    if (!agent) return;
    const policy = parseHeartbeatPolicy(agent);
    const runningCount = await countRunningRunsForAgent(agentId);
    const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
    if (availableSlots <= 0) return;

    const toEnqueue = ranked.slice(0, availableSlots);
    logger.info(
      { agentId, enqueuing: toEnqueue.length, totalReady: ranked.length, availableSlots,
        issues: toEnqueue.map((r) => ({ id: r.issueId, p: r.priority, fo: r.fanOut })) },
      `dag_dispatch: idle agent waking for ${toEnqueue.length} issue(s)`,
    );

    for (const issue of toEnqueue) {
      await enqueueWakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "idle_agent_has_assignable_work",
        payload: { issueId: issue.issueId },
        contextSnapshot: {
          issueId: issue.issueId,
          source: "dag_dispatch",
          dagRank: { priority: issue.priority, fanOut: issue.fanOut, criticalPathDepth: issue.criticalPathDepth },
        },
        requestedByActorType: "system",
        requestedByActorId: "dag_dispatch",
      });
    }

    lastDispatchAt.set(agentId, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Stale execution lock cleanup on terminal issues
  //
  // Done/cancelled issues should never hold an execution lock — the run is
  // over.  PAX-413 patches prevent new stale locks, but existing cruft
  // (PAX-411) and any future race-condition leftovers need periodic cleanup.
  // ---------------------------------------------------------------------------
  async function clearTerminalIssueLocks() {
    const result = await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(issues.status, ["done", "cancelled"]),
          sql`${issues.executionRunId} IS NOT NULL`,
        ),
      )
      .returning({ id: issues.id, identifier: issues.identifier });

    if (result.length > 0) {
      logger.info(
        { cleared: result.length, identifiers: result.map((r) => r.identifier) },
        "clearTerminalIssueLocks: cleared stale execution locks on terminal issues",
      );
    }
    return { cleared: result.length };
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    for (const { run, adapterType } of activeRuns) {
      if (activeRunExecutions.has(run.id)) continue;

      // runningProcesses usually tracks a live child, but the child may have
      // died without firing its close handler (crash, SIGKILL, cgroup OOM).
      // Verify the tracked pid is actually alive before skipping — otherwise
      // evict the stale entry and fall through so the run can be reaped.
      const trackedProc = runningProcesses.get(run.id);
      if (trackedProc) {
        const trackedPid = trackedProc.child.pid;
        if (typeof trackedPid === "number" && isProcessAlive(trackedPid)) continue;
        runningProcesses.delete(run.id);
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        continue;
      }

      const shouldRetry = tracksLocalChild && !!run.processPid && (run.processLossRetryCount ?? 0) < 1;
      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  // Watchdog: any non-terminal run older than the 10-minute task rule gets
  // escalated to the COO as a fresh issue. Deduped by (originKind='watchdog',
  // originId='run:{runId}') so subsequent ticks won't re-file for the same run.
  async function sweepStuckRuns() {
    const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

    const stuck = await db
      .select({
        runId: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        createdAt: heartbeatRuns.createdAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        agentName: agents.name,
        agentRole: agents.role,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          inArray(heartbeatRuns.status, ["queued", "running"]),
          lt(heartbeatRuns.createdAt, cutoff),
          sql`${agents.role} <> 'coo'`,
        ),
      );

    if (stuck.length === 0) return { filed: 0, skipped: 0 };

    const PER_AGENT_OPEN_WATCHDOG_CAP = 3;
    const originIds = stuck.map((s) => `run:${s.runId}`);
    const stuckAgentIds = [...new Set(stuck.map((s) => s.agentId))];
    const existing = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.originKind, "watchdog"),
          inArray(issues.originId, originIds),
          sql`${issues.status} NOT IN ('done', 'cancelled')`,
        ),
      );
    const alreadyAlerted = new Set(existing.map((e) => e.originId));

    // Per-agent cap: count all open watchdog issues for these agents (not just the
    // stuck-run subset) so a backlog of N stuck runs on one agent doesn't file N
    // new issues each sweep.
    const openWatchdogPerAgent = await db
      .select({
        agentId: heartbeatRuns.agentId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        sql`'run:' || ${heartbeatRuns.id}::text = ${issues.originId}`,
      )
      .where(
        and(
          eq(issues.originKind, "watchdog"),
          sql`${issues.status} NOT IN ('done', 'cancelled')`,
          inArray(heartbeatRuns.agentId, stuckAgentIds),
        ),
      )
      .groupBy(heartbeatRuns.agentId);
    const openCountByAgent = new Map<string, number>(
      openWatchdogPerAgent.map((row) => [row.agentId, Number(row.count)]),
    );
    const cappedAgents = new Set<string>();

    const cooByCompany = new Map<string, string>();
    async function findCoo(companyId: string): Promise<string | null> {
      const cached = cooByCompany.get(companyId);
      if (cached) return cached;
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "coo"),
            sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      cooByCompany.set(companyId, row.id);
      return row.id;
    }

    let filed = 0;
    let skipped = 0;
    let cappedSkips = 0;
    const issueSvc = issueService(db);
    // Track which COOs need a single wake after filing all alerts
    const coosToWake = new Map<string, { companyId: string; issueIds: string[] }>();
    for (const s of stuck) {
      if (alreadyAlerted.has(`run:${s.runId}`)) {
        skipped += 1;
        continue;
      }
      if ((openCountByAgent.get(s.agentId) ?? 0) >= PER_AGENT_OPEN_WATCHDOG_CAP) {
        cappedSkips += 1;
        cappedAgents.add(s.agentId);
        continue;
      }
      const cooId = await findCoo(s.companyId);
      if (!cooId) {
        skipped += 1;
        continue;
      }
      const ageMinutes = Math.max(
        1,
        Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 60000),
      );
      const ctx = (s.contextSnapshot as Record<string, unknown> | null) ?? {};
      const linkedIssueId = typeof ctx.issueId === "string" ? ctx.issueId : null;
      const shortRunId = s.runId.slice(0, 8);
      const title = `Watchdog: ${s.agentName} run ${shortRunId} ${s.status} for ${ageMinutes}m`;
      const description = [
        `Heartbeat run for **${s.agentName}** has been \`${s.status}\` for **${ageMinutes} minutes**, exceeding the 10-minute task rule.`,
        ``,
        `**Run**: \`${s.runId}\``,
        `**Agent**: ${s.agentName} (\`${s.agentId}\`)`,
        `**Status**: ${s.status}`,
        `**Invocation source**: ${s.invocationSource}`,
        `**Created at**: ${new Date(s.createdAt).toISOString()}`,
        linkedIssueId ? `**Linked issue**: \`${linkedIssueId}\`` : null,
        ``,
        `**Action**: investigate why this run is not progressing. Options:`,
        `- Wait if this is legitimately long-running work`,
        `- Cancel via \`POST /api/heartbeat-runs/${s.runId}/cancel\` and requeue a smaller slice`,
        `- Reassign the underlying task if the agent is stuck`,
        ``,
        `_Auto-filed by the watchdog sweeper. Dedup: originKind=watchdog, originId=run:${s.runId}._`,
      ]
        .filter((line) => line !== null)
        .join("\n");

      try {
        const created = await issueSvc.create(s.companyId, {
          title,
          description,
          priority: "high",
          status: "todo",
          assigneeAgentId: cooId,
          originKind: "watchdog",
          originId: `run:${s.runId}`,
        });
        filed += 1;
        openCountByAgent.set(s.agentId, (openCountByAgent.get(s.agentId) ?? 0) + 1);
        logger.warn(
          {
            runId: s.runId,
            agentId: s.agentId,
            agentName: s.agentName,
            ageMinutes,
            watchdogIssueId: created.id,
            watchdogIssueIdentifier: created.identifier,
            cooId,
          },
          "watchdog: filed COO alert for stuck run",
        );
        // Collect COO wake — one wake per COO after all alerts filed
        if (!coosToWake.has(cooId)) {
          coosToWake.set(cooId, { companyId: s.companyId, issueIds: [] });
        }
        coosToWake.get(cooId)!.issueIds.push(created.id);
      } catch (err) {
        logger.warn(
          { err, runId: s.runId },
          "watchdog: failed to file COO alert for stuck run",
        );
      }
    }

    // Wake each COO at most once per sweep tick
    for (const [cooId, { issueIds }] of coosToWake) {
      await enqueueWakeup(cooId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issueIds[0], mutation: "create" },
        requestedByActorType: "system",
        requestedByActorId: "watchdog_sweeper",
        contextSnapshot: { issueIds, source: "watchdog", alertCount: issueIds.length },
      }).catch((err) => {
        logger.warn(
          { err, cooId, alertCount: issueIds.length },
          "watchdog: failed to wake COO after filing alerts",
        );
      });
    }

    if (filed > 0 || cappedSkips > 0) {
      logger.warn(
        {
          filed,
          skipped,
          cappedSkips,
          cappedAgentIds: [...cappedAgents],
          stuckCount: stuck.length,
          perAgentCap: PER_AGENT_OPEN_WATCHDOG_CAP,
        },
        "watchdog: stuck-run sweep filed new COO alerts",
      );
    }
    return { filed, skipped: skipped + cappedSkips };
  }

  // ---------------------------------------------------------------------------
  // Blocking-chain-aware prioritization sweep
  //
  // Walks the issue_relations graph per company, identifies root blockers
  // (issues that transitively block the most open work and are themselves
  // actionable), escalates their priority, and files COO alerts so the
  // orchestrator knows where to focus.  Also detects circular blocking.
  // ---------------------------------------------------------------------------
  const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review"];
  const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
  const ROOT_BLOCKER_MIN_FANOUT = 2;

  async function sweepBlockingChains() {
    const companyRows = await db
      .selectDistinct({ companyId: issues.companyId })
      .from(issues)
      .where(inArray(issues.status, OPEN_STATUSES));

    let escalated = 0;
    let cyclesDetected = 0;
    let skipped = 0;

    for (const { companyId } of companyRows) {
      // 1. Load full blocking graph + issue metadata for this company
      const edges = await db
        .select({
          blockerId: issueRelations.issueId,
          blockedId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
          ),
        );

      if (edges.length === 0) continue;

      const allIssueIds = new Set<string>();
      for (const e of edges) {
        allIssueIds.add(e.blockerId);
        allIssueIds.add(e.blockedId);
      }

      const issueMeta = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(inArray(issues.id, [...allIssueIds]));

      const issueMap = new Map(issueMeta.map((i) => [i.id, i]));

      // 2. Build adjacency lists (blocker → blocked[], blocked → blocker[])
      const blockerToBlocked = new Map<string, string[]>();
      const blockedToBlockers = new Map<string, string[]>();

      for (const e of edges) {
        const blocker = issueMap.get(e.blockerId);
        const blocked = issueMap.get(e.blockedId);
        // Only count edges where blocked issue is open (done/cancelled blockers are irrelevant)
        if (!blocker || !blocked) continue;
        if (TERMINAL_STATUSES.has(blocker.status)) continue;
        if (TERMINAL_STATUSES.has(blocked.status)) continue;

        const fwd = blockerToBlocked.get(e.blockerId) ?? [];
        fwd.push(e.blockedId);
        blockerToBlocked.set(e.blockerId, fwd);

        const rev = blockedToBlockers.get(e.blockedId) ?? [];
        rev.push(e.blockerId);
        blockedToBlockers.set(e.blockedId, rev);
      }

      // 3. Detect cycles via Kahn's algorithm (topological sort)
      const inDegree = new Map<string, number>();
      for (const [id] of blockerToBlocked) {
        if (!inDegree.has(id)) inDegree.set(id, 0);
      }
      for (const [id, blockers] of blockedToBlockers) {
        inDegree.set(id, blockers.length);
        if (!blockerToBlocked.has(id) && !inDegree.has(id)) {
          // leaf — only appears as blocked
        }
      }
      // Ensure all nodes in the live graph are in inDegree
      for (const id of [...blockerToBlocked.keys(), ...blockedToBlockers.keys()]) {
        if (!inDegree.has(id)) inDegree.set(id, 0);
      }

      const queue: string[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
      }
      const sorted: string[] = [];
      while (queue.length > 0) {
        const node = queue.shift()!;
        sorted.push(node);
        for (const child of blockerToBlocked.get(node) ?? []) {
          const newDeg = (inDegree.get(child) ?? 1) - 1;
          inDegree.set(child, newDeg);
          if (newDeg === 0) queue.push(child);
        }
      }

      const allGraphNodes = new Set([...blockerToBlocked.keys(), ...blockedToBlockers.keys()]);
      const inCycle = new Set<string>();
      for (const id of allGraphNodes) {
        if (!sorted.includes(id)) inCycle.add(id);
      }

      // 4. Compute transitive fan-out for each blocker (BFS forward)
      const fanOut = new Map<string, number>();
      for (const root of blockerToBlocked.keys()) {
        const visited = new Set<string>();
        const bfsQueue = [...(blockerToBlocked.get(root) ?? [])];
        while (bfsQueue.length > 0) {
          const cur = bfsQueue.shift()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          bfsQueue.push(...(blockerToBlocked.get(cur) ?? []));
        }
        fanOut.set(root, visited.size);
      }

      // 5. Identify root blockers: not blocked by any open issue, fan-out ≥ threshold
      const rootBlockers: Array<{
        id: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
        assigneeAgentId: string | null;
        fanOut: number;
      }> = [];

      for (const [id, fo] of fanOut) {
        if (fo < ROOT_BLOCKER_MIN_FANOUT) continue;
        const meta = issueMap.get(id);
        if (!meta) continue;
        if (TERMINAL_STATUSES.has(meta.status)) continue;
        // A root blocker has no open blockers of its own
        const ownBlockers = blockedToBlockers.get(id) ?? [];
        const hasOpenBlocker = ownBlockers.some((bid) => {
          const bm = issueMap.get(bid);
          return bm && !TERMINAL_STATUSES.has(bm.status);
        });
        if (hasOpenBlocker) continue;
        rootBlockers.push({ ...meta, fanOut: fo });
      }

      // Sort by fan-out descending — most impactful first
      rootBlockers.sort((a, b) => b.fanOut - a.fanOut);

      // 6. Look up COO for this company
      const cooRow = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "coo"),
            sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!cooRow) continue;
      const cooId = cooRow.id;
      // Collect alert issue IDs for a single COO wake after all alerts filed
      const cooAlertIssueIds = new Map<string, string[]>();

      // 7. Check existing alerts to avoid duplicates
      const originIds = [
        ...rootBlockers.map((rb) => `blocker:${rb.id}`),
        ...(inCycle.size > 0 ? [`cycle:${companyId}`] : []),
      ];

      const existingAlerts = originIds.length > 0
        ? await db
            .select({ originId: issues.originId })
            .from(issues)
            .where(
              and(
                eq(issues.originKind, "watchdog"),
                inArray(issues.originId, originIds),
                sql`${issues.status} NOT IN ('done', 'cancelled')`,
              ),
            )
        : [];

      const alreadyAlerted = new Set(existingAlerts.map((e) => e.originId));

      const issueSvc = issueService(db);

      // 8. File alerts for root blockers
      for (const rb of rootBlockers) {
        const originId = `blocker:${rb.id}`;
        if (alreadyAlerted.has(originId)) {
          skipped += 1;
          continue;
        }

        // Escalate priority to critical if it's not already
        if (rb.priority !== "critical") {
          await db
            .update(issues)
            .set({ priority: "critical", updatedAt: new Date() })
            .where(eq(issues.id, rb.id));
          logger.info(
            { issueId: rb.id, identifier: rb.identifier, oldPriority: rb.priority },
            "blocking-chain sweep: escalated root blocker to critical priority",
          );
        }

        // Collect the blocked issue identifiers for the description
        const blockedIds = blockerToBlocked.get(rb.id) ?? [];
        const directBlocked = blockedIds
          .map((bid) => issueMap.get(bid))
          .filter(Boolean)
          .map((m) => `\`${m!.identifier}\` (${m!.status})`)
          .join(", ");

        const title = `Unblock ${rb.identifier}: root blocker for ${rb.fanOut} issue${rb.fanOut > 1 ? "s" : ""}`;
        const description = [
          `**${rb.identifier}** ("${rb.title}") is blocking **${rb.fanOut} downstream issue${rb.fanOut > 1 ? "s" : ""}** (transitively).`,
          ``,
          `**Current status**: ${rb.status}`,
          `**Current priority**: ${rb.priority} → escalated to **critical**`,
          `**Assigned to**: ${rb.assigneeAgentId ? `agent \`${rb.assigneeAgentId}\`` : "unassigned"}`,
          `**Directly blocks**: ${directBlocked || "none"}`,
          ``,
          `**Action**: Prioritize unblocking this issue. Options:`,
          `- If the assignee is stuck, reassign or break the issue into smaller pieces`,
          `- If the blocker is in_review, expedite the review`,
          `- If the issue is no longer relevant, cancel it to unblock dependents`,
          ``,
          `_Auto-filed by the blocking-chain sweep. Dedup: originKind=watchdog, originId=${originId}._`,
        ].join("\n");

        try {
          const created = await issueSvc.create(companyId, {
            title,
            description,
            priority: "high",
            status: "todo",
            assigneeAgentId: cooId,
            originKind: "watchdog",
            originId,
          });
          escalated += 1;
          logger.warn(
            {
              rootBlockerId: rb.id,
              rootBlockerIdentifier: rb.identifier,
              fanOut: rb.fanOut,
              watchdogIssueId: created.id,
              cooId,
            },
            "blocking-chain sweep: filed COO alert for root blocker",
          );
          // Collect for single wake after loop
          if (!cooAlertIssueIds.has(cooId)) cooAlertIssueIds.set(cooId, []);
          cooAlertIssueIds.get(cooId)!.push(created.id);
        } catch (err) {
          logger.warn(
            { err, rootBlockerId: rb.id },
            "blocking-chain sweep: failed to file COO alert",
          );
        }
      }

      // 9. File a single alert for circular blocking if detected
      if (inCycle.size > 0) {
        const cycleOriginId = `cycle:${companyId}`;
        if (!alreadyAlerted.has(cycleOriginId)) {
          const cycleIssues = [...inCycle]
            .map((id) => issueMap.get(id))
            .filter(Boolean)
            .map((m) => `- \`${m!.identifier}\` ("${m!.title}") — ${m!.status}`)
            .join("\n");

          const title = `Circular blocking detected: ${inCycle.size} issue${inCycle.size > 1 ? "s" : ""} in dependency cycle`;
          const description = [
            `The following issues form a circular dependency and **none of them can progress**:`,
            ``,
            cycleIssues,
            ``,
            `**Action**: Break the cycle by removing at least one blocking relation, cancelling an issue, or manually marking one as done.`,
            ``,
            `_Auto-filed by the blocking-chain sweep. Dedup: originKind=watchdog, originId=${cycleOriginId}._`,
          ].join("\n");

          try {
            const created = await issueSvc.create(companyId, {
              title,
              description,
              priority: "critical",
              status: "todo",
              assigneeAgentId: cooId,
              originKind: "watchdog",
              originId: cycleOriginId,
            });
            cyclesDetected += 1;
            logger.warn(
              {
                cycleSize: inCycle.size,
                cycleIssueIds: [...inCycle],
                watchdogIssueId: created.id,
                cooId,
              },
              "blocking-chain sweep: filed COO alert for circular dependency",
            );
            // Collect for single wake after loop
            if (!cooAlertIssueIds.has(cooId)) cooAlertIssueIds.set(cooId, []);
            cooAlertIssueIds.get(cooId)!.push(created.id);
          } catch (err) {
            logger.warn(
              { err, cycleSize: inCycle.size },
              "blocking-chain sweep: failed to file cycle alert",
            );
          }
        } else {
          skipped += 1;
        }
      }

      // Wake each COO at most once per company per sweep tick
      for (const [cId, alertIssueIds] of cooAlertIssueIds) {
        await enqueueWakeup(cId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: alertIssueIds[0], mutation: "create" },
          requestedByActorType: "system",
          requestedByActorId: "blocking_chain_sweep",
          contextSnapshot: { issueIds: alertIssueIds, source: "blocking_chain_sweep", alertCount: alertIssueIds.length },
        }).catch((err) => {
          logger.warn(
            { err, cooId: cId, alertCount: alertIssueIds.length },
            "blocking-chain sweep: failed to wake COO after filing alerts",
          );
        });
      }
    }

    if (escalated > 0 || cyclesDetected > 0) {
      logger.warn(
        { escalated, cyclesDetected, skipped },
        "blocking-chain sweep: completed with actions",
      );
    }
    return { escalated, cyclesDetected, skipped };
  }

  // ---------------------------------------------------------------------------
  // Stale in_review nudge sweep
  //
  // in_review issues that sit unattended become invisible bottlenecks.
  // - ≥ 4h: re-wake the assigned agent with a review_stale nudge
  // - ≥ 12h: file a COO alert to reassign or force-approve
  // ---------------------------------------------------------------------------
  const REVIEW_NUDGE_THRESHOLD_MS = 4 * 60 * 60 * 1000;
  const REVIEW_ESCALATE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

  async function sweepStaleReviews() {
    const nudgeCutoff = new Date(Date.now() - REVIEW_NUDGE_THRESHOLD_MS);
    const escalateCutoff = new Date(Date.now() - REVIEW_ESCALATE_THRESHOLD_MS);

    const stale = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "in_review"),
          lt(issues.updatedAt, nudgeCutoff),
        ),
      );

    if (stale.length === 0) return { nudged: 0, escalated: 0, skipped: 0 };

    let nudged = 0;
    let escalatedCount = 0;
    let skipped = 0;

    // Batch-check existing alerts
    const escalateCandidateIds = stale
      .filter((i) => i.updatedAt && new Date(i.updatedAt).getTime() < escalateCutoff.getTime())
      .map((i) => `stale_review:${i.id}`);

    const existingAlerts = escalateCandidateIds.length > 0
      ? await db
          .select({ originId: issues.originId })
          .from(issues)
          .where(
            and(
              eq(issues.originKind, "watchdog"),
              inArray(issues.originId, escalateCandidateIds),
              sql`${issues.status} NOT IN ('done', 'cancelled')`,
            ),
          )
      : [];
    const alreadyAlerted = new Set(existingAlerts.map((e) => e.originId));

    // Cache COO lookups per company
    const cooByCompany = new Map<string, string | null>();
    async function findCoo(companyId: string) {
      if (cooByCompany.has(companyId)) return cooByCompany.get(companyId)!;
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "coo"),
            sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);
      cooByCompany.set(companyId, row);
      return row;
    }

    const issueSvc = issueService(db);
    // Track COO wakes — one per COO per sweep tick, not per alert
    const cooAlertIds = new Map<string, string[]>();

    for (const issue of stale) {
      const ageMs = Date.now() - new Date(issue.updatedAt!).getTime();
      const ageHours = Math.round(ageMs / (60 * 60 * 1000) * 10) / 10;
      const needsEscalation = ageMs >= REVIEW_ESCALATE_THRESHOLD_MS;

      // Nudge: re-wake the assigned agent if idle and no execution lock
      if (issue.assigneeAgentId && !issue.executionRunId) {
        await enqueueWakeup(issue.assigneeAgentId, {
          source: "on_demand",
          triggerDetail: "system",
          reason: "review_stale",
          requestedByActorType: "system",
          requestedByActorId: "stale_review_sweep",
          contextSnapshot: {
            issueId: issue.id,
            source: "stale_review_sweep",
            ageHours,
          },
        }).catch((err) => {
          logger.warn({ err, issueId: issue.id }, "stale-review sweep: failed to nudge agent");
        });
        nudged += 1;
      }

      // Escalate to COO if >12h
      if (needsEscalation) {
        const originId = `stale_review:${issue.id}`;
        if (alreadyAlerted.has(originId)) {
          skipped += 1;
          continue;
        }
        const cooId = await findCoo(issue.companyId);
        if (!cooId) {
          skipped += 1;
          continue;
        }

        const title = `Stale review: ${issue.identifier ?? issue.id} in_review for ${ageHours}h`;
        const description = [
          `**${issue.identifier}** ("${issue.title}") has been \`in_review\` for **${ageHours} hours**.`,
          ``,
          `**Assigned to**: ${issue.assigneeAgentId ? `agent \`${issue.assigneeAgentId}\`` : "unassigned"}`,
          ``,
          `**Action**: Review and either:`,
          `- Approve and move to \`done\``,
          `- Send back to \`in_progress\` with feedback`,
          `- Reassign the review to another agent`,
          ``,
          `_Auto-filed by the stale-review sweep. Dedup: originKind=watchdog, originId=${originId}._`,
        ].join("\n");

        try {
          const created = await issueSvc.create(issue.companyId, {
            title,
            description,
            priority: "high",
            status: "todo",
            assigneeAgentId: cooId,
            originKind: "watchdog",
            originId,
          });
          escalatedCount += 1;
          logger.warn(
            {
              staleIssueId: issue.id,
              staleIdentifier: issue.identifier,
              ageHours,
              watchdogIssueId: created.id,
              cooId,
            },
            "stale-review sweep: filed COO alert for stale in_review issue",
          );
          // Collect for single wake after loop
          if (!cooAlertIds.has(cooId)) cooAlertIds.set(cooId, []);
          cooAlertIds.get(cooId)!.push(created.id);
        } catch (err) {
          logger.warn(
            { err, issueId: issue.id },
            "stale-review sweep: failed to file COO alert",
          );
        }
      }
    }

    // Wake each COO at most once per sweep tick
    for (const [cId, alertIssueIds] of cooAlertIds) {
      await enqueueWakeup(cId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: alertIssueIds[0], mutation: "create" },
        requestedByActorType: "system",
        requestedByActorId: "stale_review_sweep",
        contextSnapshot: { issueIds: alertIssueIds, source: "stale_review_sweep", alertCount: alertIssueIds.length },
      }).catch((err) => {
        logger.warn(
          { err, cooId: cId, alertCount: alertIssueIds.length },
          "stale-review sweep: failed to wake COO after filing alerts",
        );
      });
    }

    if (nudged > 0 || escalatedCount > 0) {
      logger.info(
        { nudged, escalated: escalatedCount, skipped, total: stale.length },
        "stale-review sweep: completed",
      );
    }
    return { nudged, escalated: escalatedCount, skipped };
  }

  // ---------------------------------------------------------------------------
  // Stranded wakeup request reaper + deferred execution promoter
  //
  // Handles two cases:
  // 1. deferred_issue_execution requests where the issue lock has since cleared
  //    (run finished or lock was cleaned up) — promotes them to a real wakeup.
  // 2. queued wakeup requests older than 1h with no heartbeat run — cancels them
  //    as stale.
  // ---------------------------------------------------------------------------
  const DEFERRED_STALENESS_MS = 5 * 60 * 1000;
  const QUEUED_REQUEST_STALENESS_MS = 60 * 60 * 1000;

  async function reapStrandedWakeupRequests() {
    const now = new Date();
    let promoted = 0;
    let cancelledDeferred = 0;
    let cancelledQueued = 0;

    // --- Part 1: Stale deferred_issue_execution requests ---
    const deferredCutoff = new Date(now.getTime() - DEFERRED_STALENESS_MS);
    const staleDeferreds = await db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        companyId: agentWakeupRequests.companyId,
        payload: agentWakeupRequests.payload,
        source: agentWakeupRequests.source,
        createdAt: agentWakeupRequests.createdAt,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          lt(agentWakeupRequests.createdAt, deferredCutoff),
        ),
      )
      .orderBy(asc(agentWakeupRequests.createdAt));

    for (const deferred of staleDeferreds) {
      const payload = deferred.payload as Record<string, unknown> | null;
      const issueId = typeof payload?.issueId === "string" ? payload.issueId : null;
      if (!issueId) {
        // No issue ID — cancel as invalid
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: now, error: "No issueId in payload", updatedAt: now })
          .where(eq(agentWakeupRequests.id, deferred.id));
        cancelledDeferred += 1;
        continue;
      }

      const issue = await db
        .select({ id: issues.id, status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue || ["done", "cancelled"].includes(issue.status)) {
        // Issue is terminal or deleted — cancel the deferral
        await db
          .update(agentWakeupRequests)
          .set({
            status: "cancelled",
            finishedAt: now,
            error: issue ? `Issue is ${issue.status}` : "Issue not found",
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));
        cancelledDeferred += 1;
        continue;
      }

      // Check if the issue execution lock is clear
      if (issue.executionRunId) {
        const lockRun = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, issue.executionRunId))
          .then((rows) => rows[0] ?? null);
        const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
        if (lockRun && !terminalStatuses.has(lockRun.status)) continue; // Still locked by a live run
      }

      // Issue is unlocked — promote by re-issuing a wakeup
      try {
        await enqueueWakeup(deferred.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "deferred_execution_promoted",
          payload: { issueId },
          requestedByActorType: "system",
          requestedByActorId: "stranded_wakeup_reaper",
          contextSnapshot: { issueId, source: "stranded_wakeup_reaper" },
        });
        // Mark the old deferral as completed
        await db
          .update(agentWakeupRequests)
          .set({
            status: "completed",
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));
        promoted += 1;
        logger.info(
          { deferredId: deferred.id, agentId: deferred.agentId, issueId },
          "stranded-wakeup reaper: promoted stale deferred execution",
        );
      } catch (err) {
        logger.warn(
          { err, deferredId: deferred.id, issueId },
          "stranded-wakeup reaper: failed to promote deferred execution",
        );
      }
    }

    // --- Part 2: Stale queued wakeup requests with no run ---
    const queuedCutoff = new Date(now.getTime() - QUEUED_REQUEST_STALENESS_MS);
    const staleQueued = await db
      .select({
        id: agentWakeupRequests.id,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.status, "queued"),
          isNull(agentWakeupRequests.claimedAt),
          lt(agentWakeupRequests.createdAt, queuedCutoff),
        ),
      );

    for (const req of staleQueued) {
      // If it has a run ID, check if the run is still live
      if (req.runId) {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, req.runId))
          .then((rows) => rows[0] ?? null);
        const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
        if (run && !terminalRunStatuses.has(run.status)) {
          continue; // Run is still live — leave the request
        }
      }

      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled: stale queued request (never claimed)",
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, req.id));
      cancelledQueued += 1;
    }

    if (promoted > 0 || cancelledDeferred > 0 || cancelledQueued > 0) {
      logger.info(
        { promoted, cancelledDeferred, cancelledQueued },
        "stranded-wakeup reaper: completed",
      );
    }
    return { promoted, cancelledDeferred, cancelledQueued };
  }

  // ---------------------------------------------------------------------------
  // Deduplicate routine-spawned issues
  //
  // For each routine with multiple open issues (originKind='routine_execution'),
  // keep the most recently updated one and cancel the rest. Runs on every tick
  // but is effectively a no-op once duplicates are cleared.
  // ---------------------------------------------------------------------------
  async function deduplicateRoutineIssues() {
    // Find routines with more than one open issue
    const dupes = await db
      .select({
        originId: issues.originId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(issues)
      .where(
        and(
          eq(issues.originKind, "routine_execution"),
          sql`${issues.originId} IS NOT NULL`,
          inArray(issues.status, ["backlog", "todo", "in_progress", "in_review"]),
        ),
      )
      .groupBy(issues.originId)
      .having(sql`count(*) > 1`);

    if (dupes.length === 0) return { cancelled: 0 };

    let cancelled = 0;

    for (const { originId } of dupes) {
      if (!originId) continue;

      // Get all open issues for this routine, newest first
      const openIssues = await db
        .select({ id: issues.id, identifier: issues.identifier, updatedAt: issues.updatedAt })
        .from(issues)
        .where(
          and(
            eq(issues.originKind, "routine_execution"),
            eq(issues.originId, originId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review"]),
          ),
        )
        .orderBy(desc(issues.updatedAt))
        .limit(100);

      if (openIssues.length <= 1) continue;

      // Keep the first (newest), cancel the rest
      const toCancel = openIssues.slice(1).map((i) => i.id);
      const cancelledIdentifiers = openIssues.slice(1).map((i) => i.identifier);

      await db
        .update(issues)
        .set({
          status: "cancelled",
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(issues.id, toCancel));

      cancelled += toCancel.length;
      logger.info(
        { routineId: originId, kept: openIssues[0].identifier, cancelled: cancelledIdentifiers },
        "deduplicateRoutineIssues: cancelled duplicate routine issues",
      );
    }

    return { cancelled };
  }

  // ---------------------------------------------------------------------------
  // Ghost agent cleanup
  //
  // Terminates agents that never heartbeated and aren't in pending_approval.
  // These are stale clones or failed provisioning attempts. Runs on every tick
  // but is a no-op once ghosts are cleaned up.
  // ---------------------------------------------------------------------------
  async function cleanupGhostAgents() {
    const ghosts = await db
      .update(agents)
      .set({ status: "terminated", updatedAt: new Date() })
      .where(
        and(
          isNull(agents.lastHeartbeatAt),
          sql`${agents.status} NOT IN ('terminated', 'pending_approval')`,
        ),
      )
      .returning({ id: agents.id, name: agents.name });

    if (ghosts.length > 0) {
      logger.info(
        { terminated: ghosts.length, names: ghosts.map((g) => g.name) },
        "cleanupGhostAgents: terminated ghost agents that never heartbeated",
      );
    }
    return { terminated: ghosts.length };
  }

  // ---------------------------------------------------------------------------
  // COO self-watchdog (#10)
  //
  // All other sweeps route alerts to the COO.  If the COO itself goes
  // unresponsive, alerts pile up silently.  This sweep detects that:
  //   ≥ 2h with open issues and no recent run  → re-wake COO
  //   ≥ 6h                                     → escalate to CTO
  // ---------------------------------------------------------------------------
  const COO_NUDGE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
  const COO_ESCALATE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

  async function sweepCOOHealth() {
    // Find all active COO agents across companies
    const coos = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .where(
        and(
          eq(agents.role, "coo"),
          sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
        ),
      );

    if (coos.length === 0) return { nudged: 0, escalated: 0, skipped: 0 };

    let nudged = 0;
    let escalatedCount = 0;
    let skipped = 0;
    const issueSvc = issueService(db);

    for (const coo of coos) {
      // Check if COO has open (non-terminal) issues
      const openCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.assigneeAgentId, coo.id),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review"]),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => rows[0]?.count ?? 0);

      if (openCount === 0) {
        skipped += 1;
        continue;
      }

      // Check most recent completed run
      const lastRun = await db
        .select({
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, coo.id),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      // If COO has a running run right now, it's not unresponsive
      const hasActiveRun = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, coo.id),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);

      if (hasActiveRun) {
        skipped += 1;
        continue;
      }

      const lastRunTime = lastRun?.finishedAt
        ? new Date(lastRun.finishedAt).getTime()
        : coo.lastHeartbeatAt
          ? new Date(coo.lastHeartbeatAt).getTime()
          : 0;
      const idleMs = Date.now() - lastRunTime;

      if (idleMs < COO_NUDGE_THRESHOLD_MS) {
        skipped += 1;
        continue;
      }

      const idleHours = Math.round(idleMs / (60 * 60 * 1000) * 10) / 10;

      // Nudge: re-wake COO
      await enqueueWakeup(coo.id, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "self_watchdog",
        requestedByActorType: "system",
        requestedByActorId: "coo_health_sweep",
        contextSnapshot: {
          source: "coo_health_sweep",
          idleHours,
          openIssues: openCount,
        },
      }).catch((err) => {
        logger.warn({ err, cooId: coo.id }, "coo-health sweep: failed to nudge COO");
      });
      nudged += 1;

      logger.info(
        { cooId: coo.id, cooName: coo.name, idleHours, openIssues: openCount },
        "coo-health sweep: nudged idle COO",
      );

      // Escalate to CTO if ≥6h idle
      if (idleMs >= COO_ESCALATE_THRESHOLD_MS) {
        const originId = `coo_health:${coo.id}`;

        // Dedup check
        const existing = await db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.originKind, "watchdog"),
              eq(issues.originId, originId),
              sql`${issues.status} NOT IN ('done', 'cancelled')`,
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (existing) {
          skipped += 1;
          continue;
        }

        // Find CTO in this company
        const ctoRow = await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, coo.companyId),
              eq(agents.role, "cto"),
              sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!ctoRow) {
          skipped += 1;
          continue;
        }

        const title = `COO unresponsive: ${coo.name} idle for ${idleHours}h with ${openCount} open issues`;
        const description = [
          `The COO agent **${coo.name}** (\`${coo.id}\`) has not completed a run in **${idleHours} hours** and has **${openCount} open issues** assigned to it.`,
          ``,
          `All watchdog alerts (stuck runs, blocking chains, stale reviews, queue depth) route to the COO. When the COO is unresponsive, the entire alert pipeline is dead.`,
          ``,
          `**Last run finished**: ${lastRun?.finishedAt ? new Date(lastRun.finishedAt).toISOString() : "unknown"}`,
          ``,
          `**Action**: Investigate why the COO is not running. Options:`,
          `- Check if the COO agent has an error state (adapter failure, sandbox issue)`,
          `- Manually wake the COO via the API`,
          `- If the COO agent is unrecoverable, provision a replacement`,
          ``,
          `_Auto-filed by the COO health sweep. Dedup: originKind=watchdog, originId=${originId}._`,
        ].join("\n");

        try {
          const created = await issueSvc.create(coo.companyId, {
            title,
            description,
            priority: "critical",
            status: "todo",
            assigneeAgentId: ctoRow.id,
            originKind: "watchdog",
            originId,
          });
          escalatedCount += 1;
          logger.warn(
            {
              cooId: coo.id,
              cooName: coo.name,
              idleHours,
              watchdogIssueId: created.id,
              ctoId: ctoRow.id,
            },
            "coo-health sweep: escalated unresponsive COO to CTO",
          );
          await enqueueWakeup(ctoRow.id, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: { issueId: created.id, mutation: "create" },
            requestedByActorType: "system",
            requestedByActorId: "coo_health_sweep",
            contextSnapshot: { issueId: created.id, source: "coo_health_sweep" },
          }).catch((err) => {
            logger.warn(
              { err, watchdogIssueId: created.id, ctoId: ctoRow.id },
              "coo-health sweep: failed to wake CTO after filing alert",
            );
          });
        } catch (err) {
          logger.warn(
            { err, cooId: coo.id },
            "coo-health sweep: failed to file CTO alert",
          );
        }
      }
    }

    if (nudged > 0 || escalatedCount > 0) {
      logger.info(
        { nudged, escalated: escalatedCount, skipped, cooCount: coos.length },
        "coo-health sweep: completed",
      );
    }
    return { nudged, escalated: escalatedCount, skipped };
  }

  // ---------------------------------------------------------------------------
  // Agent queue depth sweep (#11)
  //
  // Detects agents with deep wakeup queues (>3 queued requests), which signals
  // serialization bottlenecks. Files COO alert so work can be redistributed.
  // ---------------------------------------------------------------------------
  const QUEUE_DEPTH_ALERT_THRESHOLD = 3;

  async function sweepAgentQueueDepth() {
    // Count queued wakeup requests per agent
    const queueDepths = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        depth: sql<number>`count(*)::int`,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "queued"))
      .groupBy(agentWakeupRequests.agentId);

    const deep = queueDepths.filter((q) => q.depth > QUEUE_DEPTH_ALERT_THRESHOLD);
    if (deep.length === 0) return { alerted: 0, skipped: 0 };

    // Lookup agent names for logging and alert text
    const agentIds = deep.map((d) => d.agentId);
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
      .from(agents)
      .where(inArray(agents.id, agentIds));
    const agentMap = new Map(agentRows.map((a) => [a.id, a]));

    let alerted = 0;
    let skipped = 0;
    const issueSvc = issueService(db);

    // Cache COO lookups per company
    const cooByCompany = new Map<string, string | null>();
    async function findCoo(companyId: string) {
      if (cooByCompany.has(companyId)) return cooByCompany.get(companyId)!;
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "coo"),
            sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);
      cooByCompany.set(companyId, row);
      return row;
    }

    // Batch dedup check
    const originIds = deep.map((d) => `queue_depth:${d.agentId}`);
    const existingAlerts = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.originKind, "watchdog"),
          inArray(issues.originId, originIds),
          sql`${issues.status} NOT IN ('done', 'cancelled')`,
        ),
      );
    const alreadyAlerted = new Set(existingAlerts.map((e) => e.originId));
    const queueCooAlerts = new Map<string, string[]>();

    for (const q of deep) {
      const agent = agentMap.get(q.agentId);
      if (!agent) {
        skipped += 1;
        continue;
      }

      const originId = `queue_depth:${q.agentId}`;
      if (alreadyAlerted.has(originId)) {
        skipped += 1;
        continue;
      }

      // Don't alert the COO about itself
      const cooId = await findCoo(agent.companyId);
      if (!cooId) {
        skipped += 1;
        continue;
      }
      if (cooId === q.agentId) {
        skipped += 1;
        continue;
      }

      const title = `Queue bottleneck: ${agent.name} has ${q.depth} queued wakeups`;
      const description = [
        `Agent **${agent.name}** (\`${q.agentId}\`) has **${q.depth} queued wakeup requests**, exceeding the threshold of ${QUEUE_DEPTH_ALERT_THRESHOLD}.`,
        ``,
        `This indicates a serialization bottleneck — work is piling up faster than the agent can process it.`,
        ``,
        `**Action**: Consider redistributing work. Options:`,
        `- Reassign some of the agent's issues to a less loaded agent`,
        `- If the agent has a parallel-capable peer (e.g. Alpha/Bravo), route independent tasks to the peer`,
        `- Check if the agent is stuck on a blocking issue that could be fast-tracked`,
        `- Cancel stale or duplicate queued wakeups if any are redundant`,
        ``,
        `_Auto-filed by the queue-depth sweep. Dedup: originKind=watchdog, originId=${originId}._`,
      ].join("\n");

      try {
        const created = await issueSvc.create(agent.companyId, {
          title,
          description,
          priority: "high",
          status: "todo",
          assigneeAgentId: cooId,
          originKind: "watchdog",
          originId,
        });
        alerted += 1;
        logger.warn(
          {
            agentId: q.agentId,
            agentName: agent.name,
            queueDepth: q.depth,
            watchdogIssueId: created.id,
            cooId,
          },
          "queue-depth sweep: filed COO alert for deep queue",
        );
        if (!queueCooAlerts.has(cooId)) queueCooAlerts.set(cooId, []);
        queueCooAlerts.get(cooId)!.push(created.id);
      } catch (err) {
        logger.warn(
          { err, agentId: q.agentId },
          "queue-depth sweep: failed to file COO alert",
        );
      }
    }

    // Wake each COO at most once per sweep tick
    for (const [cId, alertIssueIds] of queueCooAlerts) {
      await enqueueWakeup(cId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: alertIssueIds[0], mutation: "create" },
        requestedByActorType: "system",
        requestedByActorId: "queue_depth_sweep",
        contextSnapshot: { issueIds: alertIssueIds, source: "queue_depth_sweep", alertCount: alertIssueIds.length },
      }).catch((err) => {
        logger.warn(
          { err, cooId: cId, alertCount: alertIssueIds.length },
          "queue-depth sweep: failed to wake COO after filing alerts",
        );
      });
    }

    if (alerted > 0) {
      logger.warn(
        { alerted, skipped, deepAgents: deep.length },
        "queue-depth sweep: completed with alerts",
      );
    }
    return { alerted, skipped };
  }

  // ---------------------------------------------------------------------------
  // Wasted run detector (#12)
  //
  // Samples the last N completed runs per agent. If ≥ threshold are "no-ops"
  // (low output tokens AND no issue status change during the run), files a COO
  // alert so the root cause (bad instructions, missing context, blocked deps)
  // can be investigated.
  // ---------------------------------------------------------------------------
  const WASTED_RUN_SAMPLE_SIZE = 10;
  const WASTED_RUN_ALERT_THRESHOLD = 8; // 8 out of 10
  const WASTED_RUN_MAX_OUTPUT_TOKENS = 150;

  async function sweepWastedRunPatterns() {
    // Get all active (non-terminated, non-paused) agents
    const activeAgents = await db
      .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
      .from(agents)
      .where(
        sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
      );

    if (activeAgents.length === 0) return { alerted: 0, skipped: 0 };

    let alerted = 0;
    let skipped = 0;
    const issueSvc = issueService(db);

    // Cache COO lookups
    const cooByCompany = new Map<string, string | null>();
    async function findCoo(companyId: string) {
      if (cooByCompany.has(companyId)) return cooByCompany.get(companyId)!;
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "coo"),
            sql`${agents.status} NOT IN ('terminated', 'paused', 'pending_approval')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);
      cooByCompany.set(companyId, row);
      return row;
    }

    // Batch dedup check
    const originIds = activeAgents.map((a) => `wasted_runs:${a.id}`);
    const existingAlerts = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.originKind, "watchdog"),
          inArray(issues.originId, originIds),
          sql`${issues.status} NOT IN ('done', 'cancelled')`,
        ),
      );
    const alreadyAlerted = new Set(existingAlerts.map((e) => e.originId));
    const wastedCooAlerts = new Map<string, string[]>();

    for (const agent of activeAgents) {
      const originId = `wasted_runs:${agent.id}`;
      if (alreadyAlerted.has(originId)) {
        skipped += 1;
        continue;
      }

      // Sample the last N completed runs
      const recentRuns = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          usageJson: heartbeatRuns.usageJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agent.id),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(WASTED_RUN_SAMPLE_SIZE);

      // Need at least a full sample to judge
      if (recentRuns.length < WASTED_RUN_SAMPLE_SIZE) {
        skipped += 1;
        continue;
      }

      // Count no-op runs: low output tokens
      let wastedCount = 0;
      let wastedTokens = 0;
      const wastedRunIds: string[] = [];

      for (const run of recentRuns) {
        const usage = run.usageJson as Record<string, unknown> | null;
        const rawOut = typeof usage?.rawOutputTokens === "number" ? usage.rawOutputTokens : Infinity;

        if (rawOut < WASTED_RUN_MAX_OUTPUT_TOKENS) {
          wastedCount += 1;
          wastedRunIds.push(run.id.slice(0, 8));
          const inputTok = typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
          wastedTokens += inputTok + rawOut;
        }
      }

      if (wastedCount < WASTED_RUN_ALERT_THRESHOLD) {
        skipped += 1;
        continue;
      }

      // Don't alert COO about itself churning — COO health sweep handles that
      const cooId = await findCoo(agent.companyId);
      if (!cooId) {
        skipped += 1;
        continue;
      }
      if (cooId === agent.id) {
        skipped += 1;
        continue;
      }

      // Approximate cost of wasted tokens (rough: $3/M input, $15/M output)
      const approxWastedCostUsd = (wastedTokens / 1_000_000) * 5; // blended estimate
      const costStr = approxWastedCostUsd < 0.01 ? "<$0.01" : `~$${approxWastedCostUsd.toFixed(2)}`;

      const title = `Churning: ${agent.name} — ${wastedCount}/${WASTED_RUN_SAMPLE_SIZE} recent runs were no-ops`;
      const description = [
        `Agent **${agent.name}** (\`${agent.id}\`) had **${wastedCount} out of ${WASTED_RUN_SAMPLE_SIZE}** recent completed runs produce very little output (<${WASTED_RUN_MAX_OUTPUT_TOKENS} tokens).`,
        ``,
        `This suggests the agent is waking up repeatedly without making meaningful progress — burning tokens on context loading for minimal work.`,
        ``,
        `**Approximate wasted tokens**: ${wastedTokens.toLocaleString()} (${costStr} estimated)`,
        `**Sample run IDs**: ${wastedRunIds.join(", ")}`,
        ``,
        `**Action**: Investigate root cause. Common patterns:`,
        `- Agent has no actionable work but keeps getting timer-woken (check heartbeat interval)`,
        `- Agent is stuck on a blocking dependency and keeps re-reading context without progress`,
        `- Agent instructions are too vague, causing exploratory no-op runs`,
        `- Agent's assigned issues are all blocked or in_review with nothing to do`,
        ``,
        `_Auto-filed by the wasted-run sweep. Dedup: originKind=watchdog, originId=${originId}._`,
      ].join("\n");

      try {
        const created = await issueSvc.create(agent.companyId, {
          title,
          description,
          priority: "medium",
          status: "todo",
          assigneeAgentId: cooId,
          originKind: "watchdog",
          originId,
        });
        alerted += 1;
        logger.warn(
          {
            agentId: agent.id,
            agentName: agent.name,
            wastedCount,
            wastedTokens,
            watchdogIssueId: created.id,
            cooId,
          },
          "wasted-run sweep: filed COO alert for churning agent",
        );
        if (!wastedCooAlerts.has(cooId)) wastedCooAlerts.set(cooId, []);
        wastedCooAlerts.get(cooId)!.push(created.id);
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id },
          "wasted-run sweep: failed to file COO alert",
        );
      }
    }

    // Wake each COO at most once per sweep tick
    for (const [cId, alertIssueIds] of wastedCooAlerts) {
      await enqueueWakeup(cId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: alertIssueIds[0], mutation: "create" },
        requestedByActorType: "system",
        requestedByActorId: "wasted_run_sweep",
        contextSnapshot: { issueIds: alertIssueIds, source: "wasted_run_sweep", alertCount: alertIssueIds.length },
      }).catch((err) => {
        logger.warn(
          { err, cooId: cId, alertCount: alertIssueIds.length },
          "wasted-run sweep: failed to wake COO after filing alerts",
        );
      });
    }

    if (alerted > 0) {
      logger.warn(
        { alerted, skipped, agentCount: activeAgents.length },
        "wasted-run sweep: completed with alerts",
      );
    }
    return { alerted, skipped };
  }

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      // PAX-2177: Load all queued runs, re-rank by DAG priority instead of FIFO.
      let queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt));
      if (queuedRuns.length === 0) return [];
      if (queuedRuns.length > 1) {
        try { queuedRuns = await rankQueuedRunsByDagPriority(queuedRuns); }
        catch (err) { logger.warn({ err, agentId }, "dag_dispatch: rank failed, falling back to FIFO"); }
      }
      queuedRuns = queuedRuns.slice(0, availableSlots);

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const explicitResumeSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
    );
    const explicitResumeSessionDisplayId = truncateDisplayId(
      readNonEmptyString(context.resumeSessionDisplayId) ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
        readNonEmptyString(explicitResumeSessionParams?.sessionId),
    );
    const previousSessionParams =
      explicitResumeSessionParams ??
      (explicitResumeSessionDisplayId ? { sessionId: explicitResumeSessionDisplayId } : null) ??
      normalizeSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null));
    const config = parseObject(agent.adapterConfig);
    const requestedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: requestedExecutionWorkspaceMode !== "agent_default" },
    );
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          status: issueContext.status,
          priority: issueContext.priority,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const paperclipWakePayload = await buildPaperclipWakePayload({
      db,
      companyId: agent.companyId,
      contextSnapshot: context,
      issueSummary: issueRef
        ? {
            id: issueRef.id,
            identifier: issueRef.identifier,
            title: issueRef.title,
            status: issueRef.status,
            priority: issueRef.priority,
          }
        : null,
    });
    if (paperclipWakePayload) {
      context[PAPERCLIP_WAKE_PAYLOAD_KEY] = paperclipWakePayload;
    } else {
      // Plugin session messages (e.g. Signal) carry the user's message in
      // context.prompt.  Surface it as a minimal wake payload so that
      // renderPaperclipWakePrompt can pass it through to the adapter prompt.
      const directPrompt = readNonEmptyString(context.prompt);
      if (directPrompt) {
        context[PAPERCLIP_WAKE_PAYLOAD_KEY] = { prompt: directPrompt };
      } else {
        delete context[PAPERCLIP_WAKE_PAYLOAD_KEY];
      }
    }
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    const persistedExecutionWorkspaceMode = shouldReuseExisting && existingExecutionWorkspace
      ? issueExecutionWorkspaceModeForPersistedWorkspace(existingExecutionWorkspace.mode)
      : null;
    const effectiveExecutionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode> =
      persistedExecutionWorkspaceMode === "isolated_workspace" ||
      persistedExecutionWorkspaceMode === "operator_branch" ||
      persistedExecutionWorkspaceMode === "agent_default"
        ? persistedExecutionWorkspaceMode
        : requestedExecutionWorkspaceMode;
    const workspaceManagedConfig = shouldReuseExisting
      ? { ...config }
      : buildExecutionWorkspaceAdapterConfig({
          agentConfig: config,
          projectPolicy: projectExecutionWorkspacePolicy,
          issueSettings: issueExecutionWorkspaceSettings,
          mode: requestedExecutionWorkspaceMode,
          legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
        });
    const persistedWorkspaceManagedConfig = applyPersistedExecutionWorkspaceConfig({
      config: workspaceManagedConfig,
      workspaceConfig: existingExecutionWorkspace?.config ?? null,
      mode: effectiveExecutionWorkspaceMode,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...persistedWorkspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : persistedWorkspaceManagedConfig;
    const configSnapshot = buildExecutionWorkspaceConfigSnapshot(mergedConfig);
    const executionRunConfig = stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      executionRunConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const runtimeConfig = {
      ...resolvedConfig,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspaceBase = {
      baseCwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    } satisfies ExecutionWorkspaceInput;
    const reusedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? buildRealizedExecutionWorkspaceFromPersisted({
          base: executionWorkspaceBase,
          workspace: existingExecutionWorkspace,
        })
      : null;
    const executionWorkspace = reusedExecutionWorkspace ?? await realizeExecutionWorkspace({
          base: executionWorkspaceBase,
          config: runtimeConfig,
          issue: issueRef,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          recorder: workspaceOperationRecorder,
        });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    let persistedExecutionWorkspace = null;
    const nextExecutionWorkspaceMetadataBase = {
      ...(existingExecutionWorkspace?.metadata ?? {}),
      source: executionWorkspace.source,
      createdByRuntime: executionWorkspace.created,
    } as Record<string, unknown>;
    const nextExecutionWorkspaceMetadata = shouldReuseExisting
      ? nextExecutionWorkspaceMetadataBase
      : configSnapshot
        ? mergeExecutionWorkspaceConfig(nextExecutionWorkspaceMetadataBase, configSnapshot)
        : nextExecutionWorkspaceMetadataBase;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: nextExecutionWorkspaceMetadata,
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            cleanupCommand: configSnapshot?.cleanupCommand ?? null,
            teardownCommand: configSnapshot?.teardownCommand ?? projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace) {
      const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
      const shouldSwitchIssueToExistingWorkspace =
        issueRef?.executionWorkspacePreference === "reuse_existing" ||
        requestedExecutionWorkspaceMode === "isolated_workspace" ||
        requestedExecutionWorkspaceMode === "operator_branch";
      const nextIssuePatch: Record<string, unknown> = {};
      if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
        nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
      }
      if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
        nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
      }
      if (shouldSwitchIssueToExistingWorkspace) {
        nextIssuePatch.executionWorkspacePreference = "reuse_existing";
        nextIssuePatch.executionWorkspaceSettings = {
          ...(issueExecutionWorkspaceSettings ?? {}),
          mode: nextIssueWorkspaceMode,
        };
      }
      if (Object.keys(nextIssuePatch).length > 0) {
        await issuesSvc.update(issueId, nextIssuePatch);
      }
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    const instanceRoot = resolvePaperclipInstanceRoot();
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: effectiveExecutionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
      instanceRoot,
      companyDir: path.resolve(instanceRoot, "companies", agent.companyId),
      homeDir: os.homedir(),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id, runId: run.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        authToken: authToken ?? undefined,
      });
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id, runId: run.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        normalizedUsage || adapterResult.costUsd != null
          ? ({
              ...(normalizedUsage ?? {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...((nextSessionState.displayId ?? nextSessionState.legacySessionId)
                ? { persistedSessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId }
                : {}),
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        if (issueId && outcome === "succeeded") {
          try {
            const issueComment = buildHeartbeatRunIssueComment(adapterResult.resultJson ?? null);
            if (issueComment) {
              await issuesSvc.addComment(issueId, issueComment, { agentId: agent.id });
            }
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post run summary comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      if (outcome === "succeeded") {
        void quotaHealth.checkAfterRun(agent.companyId);
      } else if (adapterResult.errorMessage) {
        void quotaHealth.handleCreditError(agent.companyId, agent.id, adapterResult.errorMessage);
      }

      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      void quotaHealth.handleCreditError(agent.companyId, agent.id, message);

      await finalizeAgentStatus(agent.id, "failed");
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore =
          readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
          await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        // Dedup: scrub promoted comment IDs from remaining deferred requests
        // so subsequent promotions do not re-include the same comments.
        const promotedCommentIds = extractWakeCommentIds(promotedContextSnapshot);
        if (promotedCommentIds.length > 0) {
          const promotedIdSet = new Set(promotedCommentIds);
          const remainingDeferred = await tx
            .select({
              id: agentWakeupRequests.id,
              payload: agentWakeupRequests.payload,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, issue.companyId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            );

          for (const rem of remainingDeferred) {
            const remPayload = parseObject(rem.payload);
            const remContext = parseObject(remPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            if (stripPromotedCommentIdsFromSnapshot(remContext, promotedIdSet)) {
              remPayload[DEFERRED_WAKE_CONTEXT_KEY] = remContext;
              await tx
                .update(agentWakeupRequests)
                .set({ payload: remPayload, updatedAt: new Date() })
                .where(eq(agentWakeupRequests.id, rem.id));
            }
          }
        }

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    trackDispatchSource(source);
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    let issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const explicitResumeSession = await resolveExplicitResumeSessionOverride(agent, payload, taskKey);
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId = explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId = explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams = explicitResumeSession.sessionParams;
      if (!readNonEmptyString(enrichedContextSnapshot.issueId) && explicitResumeSession.issueId) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskId) && explicitResumeSession.taskId) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskKey) && explicitResumeSession.taskKey) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey = readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      await resolveSessionBeforeForWakeup(agent, effectiveTaskKey);

    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelQueuedRunsForIssueInternal(
    issueId: string,
    reason = "Target issue is no longer actionable",
  ): Promise<{ cancelledCount: number; runIds: string[] }> {
    if (!issueId) return { cancelledCount: 0, runIds: [] };
    const queued = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      );
    const cancelledIds: string[] = [];
    for (const { id } of queued) {
      try {
        const cancelled = await cancelRunInternal(id, reason);
        if (cancelled?.status === "cancelled") cancelledIds.push(id);
      } catch (err) {
        logger.warn(
          { err, runId: id, issueId },
          "failed to cancel queued run for terminal issue",
        );
      }
    }
    if (cancelledIds.length > 0) {
      logger.info(
        { issueId, cancelledCount: cancelledIds.length, runIds: cancelledIds },
        "cancelled queued heartbeat runs because target issue became terminal",
      );
    }
    return { cancelledCount: cancelledIds.length, runIds: cancelledIds };
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses.delete(run.id);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = limit ? await query.limit(limit) : await query;
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    clearTerminalIssueLocks,

    sweepStuckRuns,

    sweepBlockingChains,

    sweepStaleReviews,

    reapStrandedWakeupRequests,

    deduplicateRoutineIssues,

    cleanupGhostAgents,

    sweepCOOHealth,

    sweepAgentQueueDepth,

    sweepWastedRunPatterns,

    resumeQueuedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;
      let throttled = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        // PAX-2177: use fallbackIntervalSec (3x normal) — timers are now safety net
        const timerIntervalSec = policy.fallbackIntervalSec > 0 ? policy.fallbackIntervalSec : policy.intervalSec;
        if (elapsedMs < timerIntervalSec * 1000) continue;

        // Circuit breaker: if the last 3 succeeded runs were all no-ops
        // (< 10s duration, < 100 raw output tokens), back off the timer
        // to avoid tight-loop polling that burns tokens for no work.
        const IDLE_RUN_LOOKBACK = 3;
        const IDLE_MAX_DURATION_SEC = 10;
        const IDLE_MAX_OUTPUT_TOKENS = 100;
        const IDLE_BACKOFF_MULTIPLIER = 4;
        const MAX_BACKOFF_MULTIPLIER = 10;

        const recentRuns = await db
          .select({
            status: heartbeatRuns.status,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            usageJson: heartbeatRuns.usageJson,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.id),
              eq(heartbeatRuns.status, "succeeded"),
            ),
          )
          .orderBy(desc(heartbeatRuns.finishedAt))
          .limit(IDLE_RUN_LOOKBACK);

        if (recentRuns.length === IDLE_RUN_LOOKBACK) {
          const allIdle = recentRuns.every((r) => {
            if (!r.startedAt || !r.finishedAt) return false;
            const durSec =
              (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
            const usage = r.usageJson as Record<string, unknown> | null;
            const rawOut = typeof usage?.rawOutputTokens === "number" ? usage.rawOutputTokens : Infinity;
            return durSec < IDLE_MAX_DURATION_SEC && rawOut < IDLE_MAX_OUTPUT_TOKENS;
          });

          if (allIdle) {
            const effectiveIntervalMs =
              policy.intervalSec * 1000 * Math.min(IDLE_BACKOFF_MULTIPLIER, MAX_BACKOFF_MULTIPLIER);
            if (elapsedMs < effectiveIntervalMs) {
              throttled += 1;
              continue;
            }
          }
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      if (throttled > 0) {
        logger.info({ throttled }, "tickTimers: circuit-breaker throttled idle agent timer wakeups");
      }

      return { checked, enqueued, skipped, throttled };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelQueuedRunsForIssue: (issueId: string, reason?: string) =>
      cancelQueuedRunsForIssueInternal(issueId, reason),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
