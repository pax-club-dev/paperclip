-- Backfill: any issue still in "blocked" moves to "todo". Blocked-ness is now
-- derived from open issue_relations rows of type 'blocks' whose blocker isn't
-- in a terminal status — it is no longer represented in issues.status.
UPDATE "issues" SET "status" = 'todo' WHERE "status" = 'blocked';--> statement-breakpoint
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review');
