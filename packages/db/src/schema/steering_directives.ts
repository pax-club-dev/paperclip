import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

/**
 * Steering directives — composable instructions that shape agent behavior.
 *
 * Directives are scoped to company, project, agent, or issue level and
 * composed in priority order (company → project → agent → issue) into
 * the heartbeat context so agents receive them at the start of each run.
 */
export const steeringDirectives = pgTable(
  "steering_directives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Scope level: "company" | "project" | "agent" | "issue". */
    scope: text("scope").notNull(),
    /** ID of the scoped entity (companyId, projectId, agentId, or issueId). */
    scopeId: uuid("scope_id").notNull(),
    /** Short machine-friendly key (e.g. "tone", "format", "security"). */
    key: text("key").notNull(),
    /** The directive content — markdown instruction text. */
    content: text("content").notNull(),
    /** Composition priority within the same scope (lower = applied first). */
    priority: integer("priority").notNull().default(0),
    /** Whether this directive is currently active. */
    active: boolean("active").notNull().default(true),
    /** Optional: restrict to a specific project. */
    projectId: uuid("project_id").references(() => projects.id),
    /** Optional: restrict to a specific agent. */
    agentId: uuid("agent_id").references(() => agents.id),
    /** Who created it (agent or user). */
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("steering_directives_company_idx").on(table.companyId),
    scopeIdx: index("steering_directives_scope_idx").on(table.scope, table.scopeId),
    agentIdx: index("steering_directives_agent_idx").on(table.agentId),
    activeIdx: index("steering_directives_active_idx").on(table.companyId, table.active),
  }),
);
