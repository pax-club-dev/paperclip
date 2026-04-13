/**
 * Lifecycle Hook Service — stub implementation.
 *
 * Provides a no-op executeEvent() so heartbeat code that references
 * lifecycle hooks compiles and runs without error. Replace with a real
 * implementation when lifecycle-hook functionality is needed.
 */

import type { Db } from "@paperclipai/db";

export class LifecycleHookGateError extends Error {
  hookId: string;
  constructor(hookId: string, message: string) {
    super(message);
    this.name = "LifecycleHookGateError";
    this.hookId = hookId;
  }
}

interface ExecuteEventOpts {
  companyId: string;
  agentId: string;
  event: string;
  runId: string;
  issueId: string | null;
  payload?: Record<string, unknown>;
}

export function lifecycleHookService(_db: Db) {
  return {
    /** No-op: no hooks configured. */
    async executeEvent(_opts: ExecuteEventOpts): Promise<void> {},
  };
}
