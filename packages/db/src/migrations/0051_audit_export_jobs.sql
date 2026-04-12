CREATE TABLE "audit_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"status" text DEFAULT 'pending_count' NOT NULL,
	"filters" jsonb NOT NULL,
	"span_count" integer,
	"approval_id" uuid,
	"encrypted_output" text,
	"output_encryption_scheme" text,
	"output_encryption_key_version" integer,
	"output_encryption_iv" text,
	"output_encryption_tag" text,
	"merkle_proofs" jsonb,
	"output_size_bytes" bigint,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_export_jobs" ADD CONSTRAINT "audit_export_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_export_jobs" ADD CONSTRAINT "audit_export_jobs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_export_jobs" ADD CONSTRAINT "audit_export_jobs_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_export_jobs_company_status_idx" ON "audit_export_jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "audit_export_jobs_company_created_idx" ON "audit_export_jobs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_export_jobs_approval_idx" ON "audit_export_jobs" USING btree ("approval_id");
