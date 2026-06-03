#!/usr/bin/env node
/**
 * Ensure the MCP launcher `run-mcp.sh` exists.
 *
 * `run-mcp.sh` is gitignored (each machine may tweak PATH/node), so a fresh
 * clone won't have it — and both Cursor and Claude Desktop point their `command`
 * at it. This script copies it from the committed `run-mcp.sh.example` template
 * and marks it executable. It is:
 *   - idempotent: never overwrites an existing run-mcp.sh (your local tweaks stay),
 *   - safe in CI / as a dependency: missing template or chmod failure is a no-op.
 *
 * Wired as `postinstall` so it runs automatically on `npm install`, and also
 * exposed as `npm run setup:launcher` to (re)create it on demand.
 */
import { existsSync, copyFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "run-mcp.sh");
const template = join(repoRoot, "run-mcp.sh.example");

try {
  if (existsSync(target)) {
    // Leave any machine-specific edits untouched.
    process.exit(0);
  }
  if (!existsSync(template)) {
    // Nothing to copy (e.g. installed as a dependency without the template).
    process.exit(0);
  }
  copyFileSync(template, target);
  try {
    chmodSync(target, 0o755);
  } catch {
    // chmod can fail on some filesystems/OSes; the file is still usable.
  }
  console.error("[ensure-launcher] created run-mcp.sh from run-mcp.sh.example");
} catch (err) {
  // Never fail the install over the launcher; print a hint and move on.
  console.error(
    `[ensure-launcher] could not create run-mcp.sh (${err?.message ?? err}). ` +
      "Run `npm run setup:launcher` or `cp run-mcp.sh.example run-mcp.sh && chmod +x run-mcp.sh` manually.",
  );
}
