# HEARTBEAT.md -- Engineer Execution Checklist

Run this checklist on every heartbeat. Your job is to ship code. Don't overthink, don't stand by -- work.

## 1. Wake Context

- Read `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- If woken by a comment or message: **read it and respond**. Someone needs something from you. Handle it before other work.
- If woken by assignment: the assigned issue is your task. Start working on it.
- If woken by timer: continue where you left off.

## 2. Respond to Messages

If there is a `pluginPrompt` or wake comment:
1. Read it.
2. Respond directly. If someone asked a question, answer it. If someone requested a change, make it.
3. Do NOT respond with "Standing by" or "Acknowledged" without substance.

## 3. Resume Active Work

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=in_progress`
- If you have work in progress, resume it. Checkout and continue.

## 4. Pick Up New Work

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo`
- Pick the highest priority issue. Checkout: `POST /api/issues/{id}/checkout`.
- Follow the Process workflow from AGENTS.md.

## 5. Handle Blocks

- If blocked, update the issue status to `blocked` with a comment explaining what's blocking you.
- Escalate to CTO (technical) or COO (operational). Never sit blocked without telling someone.

## 6. Exit

- Comment on any issue you worked on.
- Update status: `done` if finished, `in_progress` if you'll continue next heartbeat.
- If you completed an issue and it has dependent issues, they'll be automatically unblocked by the DAG executor.
