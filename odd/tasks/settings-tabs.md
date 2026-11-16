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
- [ ] T2 Tabbed page: `Tabs` `listClassName` prop, `SettingsRoute` renders tabs, remembered active tab, deep links select the tab, unit tests updated (RED first). Route: delegated.
- [ ] T3 E2E: `openSettingsTab` helper, specs that expect a non-initial section switch tabs first, axe on at least two tabs. Route: delegated.

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

- T1 done. Evidence: `sections.test.ts` RED (4 failing: `SETTINGS_TABS` undefined) then GREEN (9 passed); `i18n-catalog-checks.test.ts` 20 passed; core `tsc --noEmit` clean. Route: delegated writer.

Next step: T2.
