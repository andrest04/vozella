# design-patterns-2

## Objective
Second round of the 2026-11-10 architecture audit: apply patterns only where a real forcing problem exists.

## Scope (authorized: P4, P5, P6, remaining feature cycles)
- [x] P4+C — Renderer: split `LibraryRoute.tsx` (910 lines) into container hooks (`use-bulk-actions`, `use-library-dialogs`) and a table-driven confirm dialog; break the remaining renderer feature cycles (library<->summaries, chat->session->summaries->chat, shell<->chat, test-only back-edge to summaries-test-kit). Grouped because both touch renderer feature folders, library in particular. Route: delegated (worktree agent A).
- [x] P5 — Main: split the `whenReady` wiring of `main/index.ts` (1362 lines) into one `compose-<feature>.ts` per feature, following `compose-recording.ts` / `compose-pill.ts`. No DI container. Route: delegated (worktree agent B).
- [x] P6 — Main: extract an `ImportRun` collaborator from `recording/recording-service.ts` (file and URL imports), sharing the `RecordingSessionGate`. Route: delegated (worktree agent C).

## Constraints
- Behavior-preserving refactors; typecheck, lint and all tests stay green.
- Parent reviews each diff before merging into this branch, then into main.

## Progress / evidence
- P6 merged 0d6e38b: ImportRun (import-run.ts) shares the same RecordingSessionGate; recording-service.ts 1054 -> 880 lines; characterization tests added first.
- P5 merged 01d4924: compose-settings/summaries/chat/transcription + composePillHandlers; one shared IPC server object; window-dialogs helper; index.ts 1364 -> 1028. Agent ran 8 e2e specs (50 passed).
- P4+C merged 8d3036f: LibraryRoute 910 -> 620 with use-library-dialogs (CONFIRM_TEXT table, one ConfirmDialog), use-bulk-actions, use-list-focus; no cross-feature cycles left (production or tests). Visible change: Recycle Bin refusal closes and reopens the same confirm dialog.
- Verification on merged branch: typecheck ok; lint ok (excluding untracked .agents/skills); tests contracts 69, core 2223, platform 537, desktop 2397; pnpm build ok; e2e smoke + 5 library specs: 20 passed, 1 failed once (library-ui a11y color-contrast on a dialog still fading out when the Data page was checked), passed 3/3 on rerun -> timing flake, not caused by this branch.
- RDD off (global).

## Next step
Done. Possible follow-up: make the library-ui a11y check wait for dialog close before running axe.
