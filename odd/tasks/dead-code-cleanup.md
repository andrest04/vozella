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
- [ ] T2 Unreferenced symbols and aliases
- [ ] T3 Test-only production code
- [ ] T4 Legacy Xai settings fields
- [ ] T5 Duplicate consolidation (route: delegated writer; trigger: 2+ non-trivial files)

## Checks
Per task: pnpm typecheck, pnpm lint, pnpm test (includes i18n catalog parity test). Test-first exception: pure deletion and behavior-preserving refactor; the existing suites are the proof.

## Delivery forecast
About 600-800 authored changed lines, mostly deletions. Strategy: exception-ok (user policy: no PRs, merge to main).

## Progress / evidence
Commit hashes are recorded in the next task's commit (a commit cannot hold its own hash).

- T1 (route: delegated writer). Removed 51 keys from en.json/es.json and Ui_LibraryAll from ui.en.json/ui.es.json, each re-checked with rg across apps, packages, native, scripts and e2e (no literal or template-built use). Kept after re-check: Xai_FeedbackModel (Claude Code/Codex model feedback key in contracts/settings.ts), Ui_LibraryAllProjects, Library_InboxEmpty.Text, Chat_Recipes.AutomationProperties.Name (all used), Xai_ProviderName (test-only, out of scope). Not touched: Settings_Xai*/Settings_ProviderXai.Text (also unread, but outside the listed families; candidate follow-up). i18n-catalog-checks.test.ts: dropped the now empty Settings_Calendar exception. Checks: pnpm typecheck pass; pnpm lint pass; pnpm test pass (contracts 142, core 2805, platform 984 + 34 skipped, desktop 2849 + 6 skipped).
