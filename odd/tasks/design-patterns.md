# design-patterns

## Objective
Apply design patterns only where a real forcing problem exists, from the 2026-11-10 architecture audit.

## Scope (authorized: findings 1, 2, 3, 7)
- [x] P1 — CLI engine registry: one `CLI_ENGINES` data table in core replaces scattered `'claude-code' || 'codex'` checks and the three ID vocabularies. Route: delegated (worktree agent).
- [x] P2 — Break feature import cycles: move `ConfirmDialog` (and `MarkdownView` if generic) to `ui/`, provider gate/setup to `features/ai-provider/`. Route: delegated (worktree agent).
- [x] P3 — Container/Presentational for `TranscriptionSection`: extract speaker-model and engine-delete hooks. Route: delegated (worktree agent).
- [x] P7 — `PillController` phase union replaces exclusive boolean flags. Route: delegated (worktree agent).

Out of scope: P4 LibraryRoute split, P5 main/index.ts compose split, P6 ImportRun extraction.

## Constraints
- Behavior-preserving refactors; `pnpm check` must stay green.
- Each task delegated to its own worktree agent (user request); parent reviews each diff before merging into this branch.

## Acceptance
- Each task: typecheck, lint, unit tests pass; parent review of diff; merge commit recorded below.

## Progress / evidence
- P2 merged e692b68 (+ token test path fix, import cleanup 0b6b7c6). Direct chat<->summaries and summaries<->settings cycles gone; longer cycles (library<->summaries, chat->session->summaries->chat, shell<->chat) left as follow-up.
- P3 merged (hooks use-speaker-model, use-engine-actions; component has no direct IPC).
- P7 merged 7dc7a49. Fixes a latent bug: an animated hide during a drag left the pill visible with the exit flag stuck; pinned by a test.
- P1 merged (afd8a0f + 11892c6). CLI_ENGINES table; CLI_PROVIDER_KINDS/isCliProvider live in library/settings.ts to avoid an import cycle.
- Verification on merged branch: typecheck ok; lint ok excluding untracked .agents/skills (pre-existing, not on this branch); tests contracts 69, core 2223, platform 537, desktop 2364 passed; native ok.
- RDD off (global): no native review.

## Next step
Merge refactor/design-patterns into main (user decision). Follow-ups: P4, P5, P6, remaining long feature cycles.
