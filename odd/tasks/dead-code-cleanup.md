# Feature: dead-code-cleanup

## Objective
Remove verified dead code and consolidate duplicated logic found by the 2026-11-22 audit (knip with an electron-vite entry config, jscpd, manual rg checks). No behavior change.

## Why
Orphan strings, test-only exports and five copies of the same UTF-16 cut make the codebase harder to read and let copies drift.

## Scope
In:
- T1 Orphan i18n keys: Xai/XaiAuth family, old chat recipe/thread dialogs (Chat_DeleteThread*, Chat_DeleteRecipe*, Chat_CreateRecipe*, Chat_Recipe*, Chat_Untitled, Chat_UiMarshalFailed), old folder tree (LibraryMove_*, LibraryContext_*, HistoryRow_Move, Library_Inbox), Nav_Transcript.Content, Nav_Summary.Content, Nav_ResizePane, Settings_Calendar.Text, Ui_LibraryAll. Each key re-verified with rg before removal, removed from both locales.
- T2 Unreferenced symbols and aliases: ProjectFileCorruptError, SELECTABLE_ENGINE_KINDS, SIDE_PANEL_WIDTH; unexport ProjectsController, KeyIntent, KeyInput; one name for matchShortcut/matchRecordShortcut, usesGpuOffload/isGpuBackend, cloudTranscriptionApiEngine/cloudTranscriptionProvider, projectIdSchema/guidSchema.
- T3 Test-only production code, removed with its tests: meetingLink, isExpired, liveLines, percentFromStatus, unreadableProjectCount, noticeMessage, renderer chooseWarning, resolveNormalizerGain, busyReason, structSizes, notepad-markdown.ts, pipelineRequestFromRetranscription.
- T4 Legacy settings fields selectedXaiModelId / selectedXaiEffort removed from schema and defaults; reading old settings files that still contain them must keep working.
- T5 Duplicates: one UTF-16 safe cut module in core replacing names.ts, project-names.ts, project-dir.ts, chat/text-cut.ts, live-ask/utf16.ts copies; audio-controller uses core resolveMicrophoneChoice/sameMicrophoneChoices; workspace.ts imports isSessionTab; shared fs helpers for the two platform runtime managers; one clipboard copy helper in use-summary-generation.ts; useMeetingTitles hook for ChatHistory/ChatThreadList; shared apiKeySaveResultSchema in contracts.

Out (feature decisions, handled later): recording.cancelAsk path, projects.files.add (no drop UI), diagnostics.nativeSelfTest, test kits, renderer bootstrap boilerplate, test-only i18n keys (RecordPage_LiveAnswer*, LiveCopilot_*, Sample_Greeting, Xai_ProviderName).

Kept on purpose: platform/projects/migrations/legacy-directory.ts (frozen copy), reset*Store/Cache test hooks, *_KINDS/*_KEYS parity constants, tolerant readers for old data.

## Constraints
- No behavior change; data compatibility with existing settings and meetings.
- website/index.html has an unrelated uncommitted change: never stage it.
- Delivery: solo project, merge feature branch to main, no PRs.

## Tasks
- [x] T1 Orphan i18n keys (route: delegated writer, T1-T4 together; trigger: 2+ non-trivial files)
- [x] T2 Unreferenced symbols and aliases
- [x] T3 Test-only production code
- [x] T4 Legacy Xai settings fields
- [ ] T5 Duplicate consolidation (route: delegated writer; trigger: 2+ non-trivial files)

## Checks
Per task: pnpm typecheck, pnpm lint, pnpm test (includes i18n catalog parity test). Test-first exception: pure deletion and behavior-preserving refactor; the existing suites are the proof.

## Delivery forecast
About 600-800 authored changed lines, mostly deletions. Strategy: exception-ok (user policy: no PRs, merge to main).

## Progress / evidence
Commit hashes are recorded in the next task's commit (a commit cannot hold its own hash).

- T1 (route: delegated writer). Removed 51 keys from en.json/es.json and Ui_LibraryAll from ui.en.json/ui.es.json, each re-checked with rg across apps, packages, native, scripts and e2e (no literal or template-built use). Kept after re-check: Xai_FeedbackModel (Claude Code/Codex model feedback key in contracts/settings.ts), Ui_LibraryAllProjects, Library_InboxEmpty.Text, Chat_Recipes.AutomationProperties.Name (all used), Xai_ProviderName (test-only, out of scope). Not touched: Settings_Xai*/Settings_ProviderXai.Text (also unread, but outside the listed families; candidate follow-up). i18n-catalog-checks.test.ts: dropped the now empty Settings_Calendar exception. Checks: pnpm typecheck pass; pnpm lint pass; pnpm test pass (contracts 142, core 2805, platform 984 + 34 skipped, desktop 2849 + 6 skipped). Commit 8d0b9d5.
- T2 (route: delegated writer). Deleted ProjectFileCorruptError, SELECTABLE_ENGINE_KINDS, SIDE_PANEL_WIDTH. ProjectsController, KeyIntent and KeyInput had no reader at all, so they were deleted rather than unexported (an unexported unused type fails lint). Aliases collapsed: matchRecordShortcut (the record hooks test now imports it from app/shortcuts), usesGpuOffload (more callers; its test absorbed the isGpuBackend cases), cloudTranscriptionProvider (pipeline.ts and the real STT integration test updated; the alias identity test dropped), guidSchema (projectIdSchema replaced in chat, library, projects, recording and storage contracts; it is also the id of threads and files, so the generic name is the accurate one). Checks: pnpm typecheck pass; pnpm lint pass; pnpm test pass (contracts 142, core 2804, platform 984 + 34 skipped, desktop 2849 + 6 skipped). Commit 7516769.
- T3 (route: delegated writer). Deleted with their tests: meetingLink (MEETING_LINK_PREFIX kept; the parser table still covers the compact link), isExpired (clock.test.ts removed, the Clock port stays), liveLines and percentFromStatus (the liveLines cases now call liveLinesFrom directly, so the parsing coverage stays), unreadableProjectCount, renderer noticeMessage and chooseWarning (plus the Message and RecordingNotice types only they used; core captureNotice and chooseWarning keep their own tests), resolveNormalizerGain and its three NORMALIZER_* constants, busyReason (the "run on another meeting" case passes 'run' directly), notepad-markdown.ts with its test, pipelineRequestFromRetranscription (entry-points.test.ts removed). Kept after re-check: structSizes in workers/asr/nemo-library.ts. It is a test seam over the production koffi struct definitions, and nemo-library.test.ts plus real-engine.integration.test.ts use it to pin the struct sizes and offsets to the v0.3.0 C header; removing it drops the only ABI layout guard. Coverage note: notepad-markdown.test.ts (about 100 cases) also proved that notepadExtensions Markdown survives renderMeetingMarkdown/parseMeetingMarkdown; that guard is gone with it (restorable from 7516769). Checks: pnpm typecheck pass; pnpm lint pass; pnpm test pass (contracts 142, core 2795, platform 984 + 34 skipped, desktop 2737 + 6 skipped). Commit 7839abf.
- T4 (route: delegated writer). selectedXaiModelId and selectedXaiEffort removed from appSettingsSchema (contracts/library.ts), the AppSettings interface and the FIELDS table (core/library/settings.ts). The settings reader is already tolerant: readSettings only reads the known FIELDS, the raw document keeps every key, and serializeSettings writes unknown keys after the known ones, so an old file still loads and a re-save keeps the two values (now after the known fields instead of in their old slot; new files no longer write them as null). RED/GREEN: the core settings.test.ts cases were changed first to expect no typed Xai fields while the raw document keeps them (legacy Xai file re-save, defaults table, the cd-1 cases); vitest showed 3 failing before the source change and 30/30 passing after. The platform settings-runtime test and the desktop settings-handlers test, which load a real settings.json still holding the Xai keys and check they survive a re-save, passed unchanged. Updated expectations: json-settings-store writes 20 keys instead of 22; summary-runtime and page-service tests no longer patch the removed fields. e2e settings-provider/settings-i18n specs seed these keys and assert them with toMatchObject on the file, which the tolerant writer still satisfies (e2e not run). Checks: pnpm typecheck pass; pnpm lint pass; pnpm test pass (contracts 142, core 2795, platform 984 + 34 skipped, desktop 2737 + 6 skipped). This commit's hash is recorded with T5.
