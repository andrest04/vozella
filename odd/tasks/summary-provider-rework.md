# Feature: Summary provider rework

Locator: `odd/tasks/summary-provider-rework.md` · Engram mirror: `odd/summary-provider-rework/tasks` · Branch: `feat/summary-provider-rework`

## Objective
Settings > Summary provider shows every engine with its readiness at a glance, lets the user set an engine up before it becomes active, and replaces the broken API model field with an in-app model picker.

## Problem
- One radio group of 7 engines in 3 rows; clicking a radio activates that engine at once, even with no key saved or CLI missing, so summaries can fail (`use-settings-page.ts:181-192`).
- No engine shows its state (installed, key saved) until it is selected; CLI detection runs only for the selected CLI (`packages/core/src/settings/page-service.ts:168-172`).
- The API "Model" field is an `<input list>` + `<datalist>` (`ApiProviderOptions.tsx:317-339`). Chromium filters a datalist by the current value, so only the saved model is offered; the popup is unstyled and shows raw ids.
- Local shows all 7 summary models inline, a long list in the middle of Settings.

## Approved brief (user confirmed 2026-11-12)
- Engine list: one row per engine (Local, Claude Code, Codex, OpenAI, Anthropic, Gemini, OpenAI-compatible) under the existing quiet group captions, with mark, name, a short status (In use, Ready, Not found, Needs key, Key saved, Not set up; text + icon, no status colors) and, for the active one, its model.
- Select a row to expand its setup below it; one open at a time. Opening never changes the active engine.
- "Use this engine" appears only when the engine is ready (CLI found; API key saved, or server set for compatible). Activating keeps the existing "Saved. Using …" feedback. Not-ready rows say what is missing.
- CLI detail: detection + Check again, Model, Effort (drop the useless effort help text). API detail: key (save/verify/remove), model picker, server address for compatible. Local detail: active model on one line + "Change model" opening the full model list in a dialog; the Set up wizard stays when no model is active.
- Model picker: in-app combobox listing every suggestion plus verified models, free text still allowed; known models show a readable name with the id beneath; verified-only models show their id.
- Unchanged: key storage (DPAPI), privacy notices, Grok-removed notice, setup wizard, Detect questions row at the end, in-call surfaces, EN/ES parity.

## Constraints
- Design system: DESIGN.md (ink on paper, no status colors, 4px/6px radii, 28/32px controls, 150ms motion). Strings in `apps/desktop/src/renderer/i18n/locales/` (EN + ES, parity test).
- Dependency direction: desktop -> platform -> core; contracts shared; core has no Electron/Node I/O.
- Delivery strategy: `exception-ok` (solo project: work-unit commits on the feature branch, local merge to main; no PRs).
- RDD: off (global) at start; no native review.
- Forecast: ~1200-1600 authored changed lines across tasks (advisory).

## Tasks
- [x] T0 Settings polish carried over (row hairlines, question detection grouped with the engine). Route: inline. Commit `aa7a047`.
- [x] T1 Engine readiness on the settings page. Route: delegated writer (2+ non-trivial files). Commit `00836ea`. `SettingsPageDto.engines: {kind, readiness: 'ready'|'cli-missing'|'needs-key'|'needs-server'|'needs-model', model}[]` in display order, from pure `engineStatuses()` (`packages/core/src/settings/engine-readiness.ts`); both CLIs probed concurrently; a failed probe reads as missing. Accepted deviation: the compatible engine also needs a model to be ready (runtime `apiSetupGap` requires it). RED: 5 failing tests, then GREEN. Parent spot check: core settings vitest 168 passed.
- [x] T2 Model picker. Route: delegated writer. Commit `c881004`. New `ui/Autocomplete` on Base UI 1.9 Autocomplete (all options on open, typing filters, free text, commit on pick/Enter/blur, Escape keeps text); `page.api[kind].modelLabels` id->name map from core `apiModelLabels`; datalist removed. RED: desktop 10, core 3, contracts 1 failing, then GREEN. Parent spot check: Autocomplete tests 8 passed. E2E assertion in `settings-api-keys.spec.ts` updated but not yet run (T5).
- [x] T3 Engine list UI. Route: delegated writer. Commit `e366ca2`. `EngineList.tsx` + `engine-status.ts`; `ProviderChoice.tsx` removed; "Use this engine" only when ready; `checkCliAgain(kind)`; effort help keys listed in `UNUSED_BY_DECISION` (parent decision: keep carried-over catalog intact). RED: 7 failing tests, then GREEN.
- [x] T4 Local detail. Route: delegated writer. Commit `013c0fe`. `LocalEngineSetup.tsx` (active model line + "Change model"), `Dialog` gains `size="wide"` (40rem); model errors also shown inside the dialog. RED: 3 failing tests, then GREEN. Desktop renderer vitest 1662 passed; typecheck exit 0. E2E selectors updated in settings-provider/api-keys/ui/screens specs, not yet run.
- [x] T5 E2E, visual check, detector. Route: delegated writers + parent visual check. Commits `4dd1391` (real a11y defect: row buttons named by `aria-labelledby` while showing status text → axe `label-content-name-mismatch`; stale Grok locator; 4 serial tests that did not run) and `3689d81` (closed model field shows readable name, id on focus; in-use line only when the engine is also ready). Settings e2e: 32 passed, 3 opt-in screenshot skips; settings-ui rerun by parent 8 passed. Impeccable detector: no findings. Parent screenshots light/dark reviewed.

## Checks
Focused vitest per task (`settings`, `ai-provider`, `ui`, `packages/core/src/settings`, contracts); `pnpm typecheck`; eslint on touched paths; after `pnpm build`, e2e `settings-provider`, `settings-api-keys`, `settings-ui`, `settings-i18n`, `summaries-wizard`.

## Progress
- 2026-11-12: brief confirmed; branch created; T0 committed.
- 2026-11-12: T1–T5 done. Desktop renderer vitest 1662 passed (T4), settings+ui 159 passed (T5); typecheck exit 0; settings e2e green.

## Next step
User review in the running app, then local merge into main. Follow-up feature `chat-model-picker` branches from here.
