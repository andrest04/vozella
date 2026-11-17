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
- Branch feat/projects stacked on feat/connect-existing-features (not yet merged to main).

## Tasks
- [ ] P0 Design doc docs/design/projects.md (+ critique, revision)
- [ ] P1 Contracts and ports (shared types, IPC schemas, storage schema version)
- [ ] P2 Parallel lanes (defined by design)
- [ ] P3 Integration + full checks
- [ ] P4 Multi-lens review + one fix round
- [ ] P5 E2E (VOZELLA_E2E_BACKGROUND=1)

## Progress / evidence
