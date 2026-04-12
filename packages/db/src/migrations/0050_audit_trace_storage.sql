CREATE TABLE "audit_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"action_type" text NOT NULL,
	"outcome" text NOT NULL,
	"target_resource" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"signature" text,
	"sequence_number" bigint NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_scheme" text DEFAULT 'aes-256-gcm-local-v1' NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_tag" text NOT NULL,
	"storage_tier" text DEFAULT 'hot' NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"legal_hold_reason" text,
	"retention_override_days" integer,
	"cold_migrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_deletion_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"deleted_spans_hash" text NOT NULL,
	"deleted_span_count" bigint NOT NULL,
	"time_range_start" timestamp with time zone NOT NULL,
	"time_range_end" timestamp with time zone NOT NULL,
	"storage_tier" text NOT NULL,
	"signature" text,
	"deleted_by" text DEFAULT 'system:lifecycle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_spans" ADD CONSTRAINT "audit_spans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_spans" ADD CONSTRAINT "audit_spans_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_spans" ADD CONSTRAINT "audit_spans_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_deletion_certificates" ADD CONSTRAINT "audit_deletion_certificates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_spans_company_agent_time_idx" ON "audit_spans" USING btree ("company_id","agent_id","start_time");--> statement-breakpoint
CREATE INDEX "audit_spans_company_issue_time_idx" ON "audit_spans" USING btree ("company_id","issue_id","start_time");--> statement-breakpoint
CREATE INDEX "audit_spans_company_run_idx" ON "audit_spans" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "audit_spans_tier_time_idx" ON "audit_spans" USING btree ("storage_tier","start_time");--> statement-breakpoint
CREATE INDEX "audit_spans_agent_run_seq_idx" ON "audit_spans" USING btree ("agent_id","run_id","sequence_number");--> statement-breakpoint
CREATE INDEX "audit_spans_trace_id_idx" ON "audit_spans" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "audit_deletion_certs_company_created_idx" ON "audit_deletion_certificates" USING btree ("company_id","created_at");
