-- Code Red: company-level emergency priority system
-- Only one code red can be active at a time per company.
-- When active, agents should skip all non-code-red work.

ALTER TABLE "companies"
  ADD COLUMN "code_red_issue_id" uuid,
  ADD COLUMN "code_red_declared_at" timestamptz,
  ADD COLUMN "code_red_declared_by_agent_id" uuid,
  ADD COLUMN "code_red_declared_by_user_id" text;

-- FK to issues — enforces the referenced issue actually exists
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_code_red_issue_id_fk"
  FOREIGN KEY ("code_red_issue_id") REFERENCES "issues"("id")
  ON DELETE SET NULL;

-- FK to agents — enforces the declaring agent exists
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_code_red_declared_by_agent_id_fk"
  FOREIGN KEY ("code_red_declared_by_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL;
