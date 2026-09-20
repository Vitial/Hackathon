# Vendored fork — Vital pin record

This is a whole-monorepo vendored fork of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

- **Pinned SHA:** `ddefc45fbc7f8e46dd73185e68295696d1297887` (master, 2026-09-17)
- **Imported:** 2026-09-20 via GitHub tarball (24.6 MB compressed → 94.4 MB on disk)
- **Why in-tree:** We modify deepseek-harness directly to fit Vital's architecture
  (approval round-trip via R/A/I policy, cost ceilings, cancel, sidecar deployment).
- **15 upstream symlinks** (CLAUDE.md → AGENTS.md, .claude/skills → ../.agents/skills,
  snapshot cross-references) materialized as regular file/directory copies for
  Windows compatibility. See git tree API mode `120000` for the original targets.
- **License:** MIT (see upstream LICENSE)
- **Drift tracking:** `scripts/upstream-drift.mjs` compares this pin against live master.
- **Rebase policy:** see `docs/upstream.md` § Change + rebase policy (fork in place).
