# design-patterns-2

## Objective
Second round of the 2026-11-10 architecture audit: apply patterns only where a real forcing problem exists.

## Scope (authorized: P4, P5, P6, remaining feature cycles)
- [ ] P4+C — Renderer: split `LibraryRoute.tsx` (910 lines) into container hooks (`use-bulk-actions`, `use-library-dialogs`) and a table-driven confirm dialog; break the remaining renderer feature cycles (library<->summaries, chat->session->summaries->chat, shell<->chat, test-only back-edge to summaries-test-kit). Grouped because both touch renderer feature folders, library in particular. Route: delegated (worktree agent A).
- [ ] P5 — Main: split the `whenReady` wiring of `main/index.ts` (1362 lines) into one `compose-<feature>.ts` per feature, following `compose-recording.ts` / `compose-pill.ts`. No DI container. Route: delegated (worktree agent B).
- [ ] P6 — Main: extract an `ImportRun` collaborator from `recording/recording-service.ts` (file and URL imports), sharing the `RecordingSessionGate`. Route: delegated (worktree agent C).

## Constraints
- Behavior-preserving refactors; typecheck, lint and all tests stay green.
- Parent reviews each diff before merging into this branch, then into main.

## Progress / evidence
(pending)
