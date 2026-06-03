/**
 * Setup: Install OpenBriefing into any project.
 *
 * Copies the skill, rule, hooks, and MCP config into a target project
 * so agents in that project automatically get briefed.
 *
 * Usage:
 *   npx tsx scripts/setup.ts /path/to/target/project
 *   npx tsx scripts/setup.ts .   # current directory
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "fs";
import { join, resolve, basename } from "path";

const OPENBRIEFING_ROOT = resolve(import.meta.dirname, "..");

function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: npx tsx scripts/setup.ts /path/to/target/project");
    process.exit(1);
  }

  const target = resolve(targetArg);
  if (!existsSync(target)) {
    console.error(`Target directory does not exist: ${target}`);
    process.exit(1);
  }

  console.log(`Setting up OpenBriefing in: ${target}`);
  console.log(`OpenBriefing source: ${OPENBRIEFING_ROOT}\n`);

  installSkill(target);
  installRule(target);
  installHooks(target);
  writeMcpConfig(target);

  console.log("\n[DONE] OpenBriefing installed.");
  console.log("\nNext steps:");
  console.log("  1. Add the MCP server to your Cursor settings (see .cursor/mcp.json)");
  console.log("  2. Set required env vars: GITHUB_TOKEN, DISCORD_TOKEN, DATABASE_URL");
  console.log("  3. Open a new Cursor chat -- the agent will auto-brief on session start");
}

function installSkill(target: string) {
  const skillDir = join(target, ".cursor", "skills", "openbriefing");
  const src = join(OPENBRIEFING_ROOT, "skills", "openbriefing", "SKILL.md");

  if (!existsSync(src)) {
    console.log("[SKIP] Skill file not found at source");
    return;
  }

  mkdirSync(skillDir, { recursive: true });
  copyFileSync(src, join(skillDir, "SKILL.md"));
  console.log("[OK] Installed skill -> .cursor/skills/openbriefing/SKILL.md");
}

function installRule(target: string) {
  const rulesDir = join(target, ".cursor", "rules");
  const src = join(OPENBRIEFING_ROOT, "rules", "openbriefing.mdc");

  if (!existsSync(src)) {
    console.log("[SKIP] Rule file not found at source");
    return;
  }

  mkdirSync(rulesDir, { recursive: true });
  copyFileSync(src, join(rulesDir, "openbriefing.mdc"));
  console.log("[OK] Installed rule  -> .cursor/rules/openbriefing.mdc");
}

function installHooks(target: string) {
  const hooksDir = join(target, ".cursor");
  const src = join(OPENBRIEFING_ROOT, "hooks", "hooks.json");

  if (!existsSync(src)) {
    console.log("[SKIP] Hooks file not found at source");
    return;
  }

  const dest = join(hooksDir, "hooks.json");
  if (existsSync(dest)) {
    console.log("[SKIP] hooks.json already exists in target, not overwriting");
    return;
  }

  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(src, dest);
  console.log("[OK] Installed hooks -> .cursor/hooks.json");
}

function writeMcpConfig(target: string) {
  const mcpDir = join(target, ".cursor");
  const dest = join(mcpDir, "mcp.json");

  const config = {
    mcpServers: {
      openbriefing: {
        command: join(OPENBRIEFING_ROOT, "run-mcp.sh"),
        env: {
          DATABASE_URL: "${DATABASE_URL}",
        },
      },
    },
  };

  if (existsSync(dest)) {
    try {
      const existing = JSON.parse(readFileSync(dest, "utf-8"));
      if (existing.mcpServers?.openbriefing) {
        console.log("[SKIP] mcp.json already has openbriefing configured");
        return;
      }
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers.openbriefing = config.mcpServers.openbriefing;
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(dest, JSON.stringify(existing, null, 2) + "\n");
      console.log("[OK] Added openbriefing to existing .cursor/mcp.json");
      return;
    } catch {
      console.log("[WARN] Could not parse existing mcp.json, writing new one");
    }
  }

  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(dest, JSON.stringify(config, null, 2) + "\n");
  console.log("[OK] Created .cursor/mcp.json with openbriefing server");
}

main();
