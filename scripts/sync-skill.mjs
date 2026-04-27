/**
 * Keep `.cursor/skills/openrundown/SKILL.md` in sync with the distributable
 * `skills/openrundown/SKILL.md` (what setup.ts copies into other projects).
 *
 * Usage: npm run sync:skill
 */
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "skills/openrundown/SKILL.md");
const dest = join(root, ".cursor/skills/openrundown/SKILL.md");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`[sync:skill] ${src} -> ${dest}`);
