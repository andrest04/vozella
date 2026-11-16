# Settings tabs

## Objective

Group the Settings page into four tabs so the user sees one short group at a time instead of one long list of nine sections.

## Problem and why

`SettingsRoute.tsx` draws every section of `SETTINGS_SECTIONS` in one scroll. The owner reported that users get lost. `odd/tasks/settings-polish.md` listed in-page navigation as a follow-up (critique P2). This is refinement: same sections, same copy, same look.

## Scope

| Tab id | Label (en / es) | Sections |
|---|---|---|
| recording | Recording / Grabación | microphone, recording (slot), callDetection |
| transcription | Transcription / Transcripción | meetingLanguage, transcription |
| summary | Summaries & AI / Resumen e IA | summaryProvider (+ LiveQuestions) |
| general | General / General | appearance, language, data, about |

Grouping chosen by the owner on 2026-11-15.

## Constraints

- Reuse `apps/desktop/src/renderer/ui/Tabs.tsx` (DESIGN.md: 36px tabs, 2px ink underline). No new visual language.
- New catalog keys go in `ui.en.json` / `ui.es.json`, never `en.json` / `es.json`.
- Loading and load-error states stay as they are: no tabs, Appearance still reachable.
- Deep links (`openEngineInSettings`, `openTranscriptionInSettings`) must select the right tab and still scroll and focus.
- Test-first where a deterministic Vitest test applies.
- Delivery: no PR; merge to main only when the owner asks. Strategy `single-pr` equivalent (one branch, merge).

## Tasks

- [x] T1 Core tab model and catalog keys: `SettingsTabId`, `tab` on every section, `SETTINGS_TABS`, tests; five `Ui_SettingsTab*` keys in both locales. Route: delegated (writer trigger, 2+ non-trivial files).
- [x] T2 Tabbed page: `Tabs` `listClassName` prop, `SettingsRoute` renders tabs, remembered active tab, deep links select the tab, unit tests updated (RED first). Route: delegated.
- [x] T3 E2E: `openSettingsTab` helper, specs that expect a non-initial section switch tabs first, axe on at least two tabs. Route: delegated.

## Acceptance criteria

- Four tabs in order; default tab is Recording; a revisit reopens the last tab.
- Each panel shows only its sections, with their h2 headings.
- Arrow keys move between tabs; the panel is a tab stop.
- Both deep links land on the right tab with the control focused.
- en and es labels fit without overflow in light and dark.

## Checks

- `pnpm check`
- From `apps/desktop`: `npx playwright test e2e/settings-ui.spec.ts e2e/settings-provider.spec.ts e2e/settings-api-keys.spec.ts e2e/settings-screens.spec.ts e2e/content-width.spec.ts e2e/audio-sources.spec.ts e2e/transcription-screens.spec.ts`
- `./.claude/skills/impeccable/scripts/impeccable detect --json <changed UI files>` once.

## Progress

Forecast: about 350 authored changed lines. RDD: off (global), no native review.

- T1 done (50775c4). Evidence: `sections.test.ts` RED (4 failing: `SETTINGS_TABS` undefined) then GREEN (9 passed); `i18n-catalog-checks.test.ts` 20 passed; core `tsc --noEmit` clean. Route: delegated writer.

- T2 done. Evidence: `SettingsRoute.test.tsx` RED (14 new tab tests failing: no tablist) then GREEN (71 passed); settings, ui and transcription-focus suites 166 passed; desktop typecheck, eslint and prettier clean on the changed files. The tab list is sticky (`sticky top-0 z-10 bg-paper` on the list, `scroll-mt-12` on the panel content); T3 checks it in the real window. `labelKey` is typed as the catalog literal so `t()` takes it without a cast. Deep links: `useSettingsTab` peeks at the pending target and listens; the section still consumes it. Route: delegated writer.

T3 done. Evidence (run with VOZELLA_E2E_BACKGROUND=1): 17 affected specs 88 passed, 2 failed, 33 skipped (screenshot specs); the 2 failures were the engine row count in settings-provider.spec.ts, stale on main (7, now 8), then 9 passed; settings-screens.spec.ts with VOZELLA_SCREENSHOTS=1 3 passed and the tabs were checked in the captures (es light, en dark). pnpm check: typecheck and lint clean; 21 unit tests in 7 library, chat and record files timed out under load and pass alone (228 passed). impeccable detect on SettingsRoute.tsx and Tabs.tsx: no findings. Not checked by hand in the real window: keyboard walk and both deep links (covered by unit tests only).

Next step: none; merged to main.
