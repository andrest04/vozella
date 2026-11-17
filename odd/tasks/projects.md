# Feature: projects

## Objective
Replace nested library folders with flat, Claude-style Projects centered on meetings, with durable, versioned storage that can evolve.

## Decisions (user, 2026-11-16)
- Flat projects; every existing folder (including subfolders) becomes its own project; name collisions get the parent prefix ("Universidad – Cálculo").
- Project page: name, description, "Start meeting in this project" as primary action, tabs (Meetings, Chats, plus whatever the design proves needed), right panel Instructions (edit) + Context files (add). Reference: Claude Projects screenshots.
- Chat history is persisted (per project and for "Sin proyecto").
- Meetings without project = "Sin proyecto" list with "Move to project".
- Project instructions + files feed live copilot, chat and summaries.
- Out of base: Memory, Scheduled. WinUI library compatibility may be dropped (versioned migration with backup instead).
- Workflow agents on Sonnet; parallel lanes in worktrees; phases: design -> contracts -> lanes -> integrate -> review -> fix -> e2e.
- UI follows the impeccable skill conventions (naming, design system, copy).
- Zero WinUI/.NET compatibility in the new storage (no CRLF/.NET escaping, no WinUI special cases). Remaining WinUI references elsewhere (67 files) are a separate follow-up purge.
- Branch feat/projects stacked on feat/connect-existing-features (not yet merged to main).

## Tasks
- [x] P0 Design doc docs/design/projects.md (+ critique, revision)
- [x] P1 Contracts and ports (shared types, IPC schemas, storage schema version)
- [x] P2 Parallel lanes (defined by design)
- [x] P3 Integration + full checks
- [x] P4 Multi-lens review + one fix round
- [x] P5 E2E (VOZELLA_E2E_BACKGROUND=1)

## Progress / evidence

Workflow wf_25ab7854-0b6 (17 Sonnet agents): design da69602 (19 critiques addressed); contracts 6193186; lanes L1 storage (ff7f3ee, partial only due to cross-lane removals), L2 chat threads, L3 context files, L4 recording/live, L5 UI; merged clean, glue 99f84bc; review 17 findings (2 major fixed in bb9e2d2, minors partly); e2e 2957e1c projects.spec.ts 18/18.
Parent spot check 2026-11-17: pnpm typecheck 0, pnpm lint 0, pnpm test 0.
Open: full Playwright run had failures in pill-capsule/pill-panel/pill-window/record-idle/shell-window (pixel/rect checks with off-screen windows; not baseline-compared). Lane worktrees under .claude/worktrees still exist. Remaining minor review findings in workflow output. WinUI purge (separate follow-up).
## Next step
User tries the app; then WinUI purge; merge to main when the user asks.
