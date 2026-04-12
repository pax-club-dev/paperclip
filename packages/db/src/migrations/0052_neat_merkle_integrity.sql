CREATE TABLE "audit_merkle_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_hash" text NOT NULL,
	"previous_root_hash" text,
	"batch_start_time" timestamp with time zone NOT NULL,
	"batch_end_time" timestamp with time zone NOT NULL,
	"span_count" integer NOT NULL,
	"leaf_hashes" text[] NOT NULL,
	"sequence_number" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_merkle_roots" ADD CONSTRAINT "audit_merkle_roots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_merkle_roots_company_seq_idx" ON "audit_merkle_roots" USING btree ("company_id","sequence_number");--> statement-breakpoint
CREATE INDEX "audit_merkle_roots_company_time_idx" ON "audit_merkle_roots" USING btree ("company_id","batch_start_time");--> statement-breakpoint
CREATE INDEX "audit_merkle_roots_root_hash_idx" ON "audit_merkle_roots" USING btree ("root_hash");--> statement-breakpoint
COMMENT ON TABLE "audit_merkle_roots" IS 'Append-only ledger of Merkle tree roots for audit span integrity verification (CISO §2.2). Do NOT grant UPDATE or DELETE to the application database user.';
