-- Steering Directives: composable instructions that shape agent behavior.
-- Scoped to company, project, agent, or issue level.
-- Composed in priority order into heartbeat context.

CREATE TABLE IF NOT EXISTS "steering_directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"project_id" uuid,
	"agent_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steering_directives_company_idx" ON "steering_directives" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steering_directives_scope_idx" ON "steering_directives" USING btree ("scope", "scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steering_directives_agent_idx" ON "steering_directives" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steering_directives_active_idx" ON "steering_directives" USING btree ("company_id", "active");
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steering_directives_company_id_companies_id_fk') THEN
  ALTER TABLE "steering_directives" ADD CONSTRAINT "steering_directives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steering_directives_project_id_projects_id_fk') THEN
  ALTER TABLE "steering_directives" ADD CONSTRAINT "steering_directives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steering_directives_agent_id_agents_id_fk') THEN
  ALTER TABLE "steering_directives" ADD CONSTRAINT "steering_directives_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steering_directives_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "steering_directives" ADD CONSTRAINT "steering_directives_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
