# Contributing to OpenRundown

1. Read **[AGENTS.md](AGENTS.md)** — it covers layout, how to run tests, the `project` parameter, and where the distributable `skills/openrundown/SKILL.md` lives.
2. If you edit `skills/openrundown/SKILL.md`, run **`npm run sync:skill`** so `.cursor/skills/openrundown/SKILL.md` matches.
3. Open a pull request with a clear description. Keep changes focused; run `npm test` and `npm run build` before submitting when you touch code.
4. For user-facing product behavior, see [README.md](README.md) and the [docs/](docs/) folder.

Thank you for helping make agents less blind.
