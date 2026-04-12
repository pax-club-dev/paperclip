/**
 * One-off migration script to upgrade existing agent instruction bundles
 * to the new role-specific templates (CTO, COO, Engineer, improved default).
 *
 * Usage: cd server && npx tsx ../scripts/upgrade-agent-instructions.ts
 *
 * What it does:
 * 1. Queries all agents from the database
 * 2. For each agent whose role has a new instruction bundle:
 *    - Loads the new default bundle for that role
 *    - Writes the files to the agent's managed instructions directory
 *    - Does NOT overwrite files the agent has customized (checks if content differs from old default)
 * 3. Reports what it did
 */

import postgres from "postgres";
import fs from "node:fs/promises";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@localhost:5432/paperclip";
const INSTANCE_ROOT = path.join(process.env.HOME ?? "/home/hash_naxos_vc", ".paperclip/instances/default");

const OLD_DEFAULT_CONTENT = `You are an agent at Paperclip company.

Keep the work moving until it's done. If you need QA to review it, ask them. If you need your boss to review it, ask them. If someone needs to unblock you, assign them the ticket with a comment asking for what you need. Don't let work just sit here. You must always update your task with a comment.
`;

// Map of role -> bundle directory name in onboarding-assets
const ROLE_BUNDLES: Record<string, string> = {
  cto: "cto",
  coo: "coo",
  engineer: "engineer",
  devops: "engineer",
  qa: "engineer",
  // cmo, cfo, pm, designer, researcher, general -> "default"
};

const ASSETS_ROOT = path.join(import.meta.dirname ?? __dirname, "../server/src/onboarding-assets");

async function loadBundle(bundleName: string): Promise<Record<string, string>> {
  const bundleDir = path.join(ASSETS_ROOT, bundleName);
  const entries = await fs.readdir(bundleDir);
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.endsWith(".md")) {
      files[entry] = await fs.readFile(path.join(bundleDir, entry), "utf8");
    }
  }
  return files;
}

async function main() {
  const sql = postgres(DATABASE_URL);

  try {
    // Get all agents with their roles
    const agents = await sql<{
      id: string;
      company_id: string;
      name: string;
      role: string;
      adapter_config: Record<string, unknown>;
    }[]>`SELECT id, company_id, name, role, adapter_config FROM agents ORDER BY company_id, name`;

    console.log(`Found ${agents.length} agents\n`);

    let upgraded = 0;
    let skipped = 0;
    let skippedCustom = 0;

    for (const agent of agents) {
      const bundleName = ROLE_BUNDLES[agent.role] ?? "default";

      // Skip CEO agents -- they already have good instructions
      if (agent.role === "ceo") {
        console.log(`  SKIP (ceo): ${agent.name} (${agent.id})`);
        skipped++;
        continue;
      }

      const instructionsDir = path.join(
        INSTANCE_ROOT,
        "companies",
        agent.company_id,
        "agents",
        agent.id,
        "instructions",
      );

      // Check if agent has customized instructions (not just old default)
      let hasCustomContent = false;
      try {
        const existingAgentsMd = await fs.readFile(path.join(instructionsDir, "AGENTS.md"), "utf8");
        // If the existing content is neither the old default nor empty, it's been customized
        if (
          existingAgentsMd.trim() !== OLD_DEFAULT_CONTENT.trim() &&
          existingAgentsMd.trim() !== "" &&
          !existingAgentsMd.includes("Keep the work moving until it's done")
        ) {
          hasCustomContent = true;
        }
      } catch {
        // No existing file -- will create fresh
      }

      if (hasCustomContent) {
        console.log(`  SKIP (custom): ${agent.name} [${agent.role}] (${agent.id})`);
        skippedCustom++;
        continue;
      }

      // Load and write the new bundle
      const bundle = await loadBundle(bundleName);
      await fs.mkdir(instructionsDir, { recursive: true });

      for (const [fileName, content] of Object.entries(bundle)) {
        await fs.writeFile(path.join(instructionsDir, fileName), content, "utf8");
      }

      console.log(`  UPGRADED: ${agent.name} [${agent.role}] -> ${bundleName} bundle (${Object.keys(bundle).length} files)`);
      upgraded++;
    }

    console.log(`\nDone: ${upgraded} upgraded, ${skipped} skipped (ceo), ${skippedCustom} skipped (custom content)`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
