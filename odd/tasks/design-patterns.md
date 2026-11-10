# design-patterns

## Objective
Apply design patterns only where a real forcing problem exists, from the 2026-11-10 architecture audit.

## Scope (authorized: findings 1, 2, 3, 7)
- [ ] P1 — CLI engine registry: one `CLI_ENGINES` data table in core replaces scattered `'claude-code' || 'codex'` checks and the three ID vocabularies. Route: delegated (worktree agent).
- [ ] P2 — Break feature import cycles: move `ConfirmDialog` (and `MarkdownView` if generic) to `ui/`, provider gate/setup to `features/ai-provider/`. Route: delegated (worktree agent).
- [ ] P3 — Container/Presentational for `TranscriptionSection`: extract speaker-model and engine-delete hooks. Route: delegated (worktree agent).
- [ ] P7 — `PillController` phase union replaces exclusive boolean flags. Route: delegated (worktree agent).

Out of scope: P4 LibraryRoute split, P5 main/index.ts compose split, P6 ImportRun extraction.

## Constraints
- Behavior-preserving refactors; `pnpm check` must stay green.
- Each task delegated to its own worktree agent (user request); parent reviews each diff before merging into this branch.

## Acceptance
- Each task: typecheck, lint, unit tests pass; parent review of diff; merge commit recorded below.

## Progress / evidence
(pending)
