# Feature: remove-dead-features

## Objective
Remove features that exist in the code but are not used end to end, found by a verified audit on 2026-11-16.

## Why
Half-wired code (calendar probe, unread settings, unused IPC channels, test-only helpers, orphan strings) adds maintenance cost and misleads readers.

## Scope (authorized by user: "todo en una sola rama")
Branch `chore/remove-dead-features`, merged to main (no PRs).

## Out of scope (keep)
- Xai settings/value (kept on purpose for back-compat).
- Toast system, update status granularity.
- `MeetingLive` legacy names (AGENTS.md).

## Tasks
- [x] T1 Calendar: remove CalendarProbePort/Native/Fake + addon probeCalendarsAsync + Rust calendar.rs; settings calendarNotificationsEnabled/disabledCalendarIds(+AsSet); calendarEventId take-notes plumbing; calendar i18n keys; update parity docs. Route: delegated (multi-file).
- [x] T2 Unread settings: typeSafeEnabled (+typeSafeCredentialsFilePath), navigationPaneLength (+resolveNavigationPaneLength), liveCopilotPillX/Y; resolvePillEdge/resolvePillAlong. Route: delegated.
- [ ] T3 Unused IPC: audio.recording.start/state/pause/resume/stop, audio.import.run, summaries.setTemplate, events app.focusChanged and audio.recording.notice. Route: delegated.
- [ ] T4 Test-only helpers: polish pipeline, line-index helpers, legacyCaptureSources/computeRms/normalize*, legacySecret port, chat helpers (starterRecipes, isBuiltInRecipe, sameScope, tryParseMeetingLink, meetingTimeLink), isCliAvailable, claudePrintLine/codexExecLine, shapeRadius*, dragStarted/DRAG_THRESHOLD_DIP, initialTabAfterTake, estimateTokens, formatModelSize, cloudTranscriptionBaseUrl. Route: delegated.
- [ ] T5 UI/i18n: Combobox (and gallery usage), ICON_STROKE barrel export, remaining orphan i18n keys (TypeSafe_*, PersonalTasks_*, Chat_CreateRecipe*, LiveCopilot_NeedsSetup, etc.) and shrink the allowlist in i18n-catalog-checks.test.ts (keep Xai keys). Route: delegated.
- [ ] T6 Full verification: pnpm check, native build, affected e2e specs (background). Route: delegated verifier.

## Checks
Per task: pnpm typecheck + vitest for affected packages. Test-first exception: pure deletion; proof is green typecheck/tests and zero remaining references.

## Progress
- T1 done: calendar probe (core/platform/Rust), dropped calendar settings keys, takeNotes calendarEventId plumbing and orphan calendar i18n removed; kept meeting-record calendarEventId and Settings_Calendar.Text; unknown settings keys stay in the raw file (B17). typecheck, pnpm test, cargo check/test green.
- T2 done: removed typeSafeEnabled, typeSafeCredentialsFilePath, navigationPaneLength, liveCopilotPillX/Y and the resolvePillEdge/resolvePillAlong/resolveNavigationPaneLength helpers; Xai kept; old files with removed keys keep loading (unknown keys preserved). typecheck and pnpm test green.
