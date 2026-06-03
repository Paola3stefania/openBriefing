/**
 * Keep the local `.cursor/` agent assets in sync with the distributables that
 * `scripts/setup.ts` copies into consumer projects. Source of truth lives in
 * `skills/` and `rules/` (what gets shipped); the `.cursor/` copies are local
 * mirrors so agents working on this repo see the same protocol.
 *
 * Usage: npm run sync:skill
 */
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const pairs = [
  {
    src: join(root, "skills/openbriefing/SKILL.md"),
    dest: join(root, ".cursor/skills/openbriefing/SKILL.md"),
  },
  {
    src: join(root, "rules/openbriefing.mdc"),
    dest: join(root, ".cursor/rules/openbriefing.mdc"),
  },
];

for (const { src, dest } of pairs) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[sync:skill] ${src} -> ${dest}`);
}
