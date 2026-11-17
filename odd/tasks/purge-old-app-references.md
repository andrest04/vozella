# Feature: purge-old-app-references

## Objective
Vozella is an Electron/TypeScript app with a minimal Rust addon. Remove every reference to the earlier desktop app and its stack from code, tests, fixtures, comments and docs (user decision 2026-11-17).

## Scope
Code, tests, fixtures, comments, docs (AGENTS.md, README.md, PRODUCT.md, docs/), skills and the Rust addon.

Kept on purpose:
- the data-root guard that refuses the real data folders;
- the stored internal link scheme https://meetinglive.local/meeting/;
- readers and migrations that existing Vozella users still need (folders.json migration, tolerant settings and meeting readers).

## Tasks
- [x] W0 Map and plan work units (sequential, each keeps the repo green)
- [ ] U1 Data-root guard extended, meeting folder detection removed
- [ ] U2 Tests decoupled from the docs archive
- [ ] U3 to U6 Comment and title scrubs by area
- [ ] U7 Rust addon comments
- [ ] U8 Docs archive removed, entry docs rewritten, skills and task records pruned, banned-wording guard (packages/platform/src/hygiene/banned-wording.test.ts)
- [ ] W-review Parallel review (completeness sweep, behavior and data safety) and one fix round
- [ ] W-final pnpm check, unit scripts and e2e

## Progress / evidence
Commits and check results per unit are recorded by the orchestrator.

## Result (2026-11-17)
Workflow wf_3195d9e3-a94 (16 Sonnet agents): units U1-U8 done (6b7f080..a12b703), review 13 findings (1 major) fixed in 711c104.
Parent check: no winui/dotnet/.NET hits in tracked source (only gitignored build outputs out/, release/).
Final: pnpm check pass, pnpm build pass; Playwright 202 passed, 4 failed (3 pill pixel specs, also failing before this branch; projects.spec test 9 flaky once), 29 not run.
Side effect to confirm with user: U8 deleted 62 historical odd/tasks/*.md files (still in git history and Engram mirrors) and the 3 dotnet/skills test skills.
