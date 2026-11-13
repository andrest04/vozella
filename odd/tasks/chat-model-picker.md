# Feature: Chat model picker

Locator: `odd/tasks/chat-model-picker.md` · Engram mirror: `odd/chat-model-picker/tasks` · Branch: `feat/chat-model-picker` (from `feat/summary-provider-rework`)

## Objective
The AI chat composer gets a model picker next to Send: the user picks the engine, model and effort for this chat without touching the Settings engine that writes summaries.

## Why
User request (2026-11-12): "al costado de enviar … un selector de modelos … agrupes por modelos locales, API o … Claude … eliges ahí mismo el modelo y el esfuerzo … una barrita … si no está disponible, que aparezca grisecito". Scope decided by the user: option A, chat only.

## Research (2026-11-12, sdd-research; Claude.ai and VS Code verified, others from search snippets)
- Pickers sit in the composer next to Send (Claude.ai, VS Code, Granola); the closed chip names the model.
- Menus group by kind and allow type-to-search.
- Unavailable options stay visible and dimmed with a verb (Download, Add key); dead-end disabled entries irritate users (Cursor forum).
- Effort lives in or next to the model menu, only for models that support it, with 3–5 named levels from the engine; per-conversation scope, last choice as the next default (VS Code).

## Current facts (mapped 2026-11-12)
- `chat.send` already takes `engine` (any of 7 kinds) for one send (`packages/contracts/src/chat.ts:134`), resolved through `resolveSummaryProvider({kind})` (`apps/desktop/src/main/chat/chat-controller.ts:81-94`).
- Model and effort always come from Settings (`packages/core/src/summaries/provider-factory.ts:46-82`); no per-send override exists in the contract, `SendOptions`, `ProviderSource.resolve`, `ResolveRequest` or `CreateProviderOptions`.
- The setup gate saves the gated engine as the Settings default; `useChat` restores it for saved-prompt engines but not Local's model id.
- One in-memory conversation; New chat remounts the chat body (`AiPanel.tsx:78-79, 267`), so renderer state resets there.
- `settings.getPage` has all picker data but runs hardware detection on every call.

## Design (decided under the user's delegation "tú ves la mejor opción")
- Composer: textarea on top, a toolbar line below with Recipes and Attach on the left and the picker chip + Send on the right (the chip would starve the textarea in a 320px panel on one line).
- Chip: engine mark + model label (+ effort when the engine has one), truncated; `aria-haspopup`, tooltip with the full name.
- Popup: search field, then groups On this PC / With a subscription / With your API key. Ready engines list their models as selectable rows (CLI model options; API suggested models with readable labels; Local downloaded models). Not-ready engines show one dimmed row with the reason and an action that opens that engine in Settings (Install / Add key / Set up / Download a model). Local not-downloaded models are not listed one by one; a dimmed "More models in Settings" row covers them.
- Effort: a stepped bar (one step per level from the engine's effort options, labels Low…Max, current level named) under the list, only when the chosen engine has effort.
- Footer note: "Applies to this chat. Summaries use the engine in Settings."
- Scope: the choice lives for the conversation (resets on New chat); a new chat starts from the Settings engine, model and effort. The picker never writes Settings and never offers an unready engine, so the setup gate is not triggered from it.

## Constraints
- DESIGN.md (ink on paper, no status colors, 4px/6px radii, 28/32px controls, 150ms motion, overlay shadow only on popups). EN/ES strings with parity.
- Summary generation behavior must not change.
- Delivery strategy: `exception-ok` (solo project, local merge to main). RDD off.

## Tasks
- [x] C1 Backend. Route: delegated writer. Commit `fa982ab`. `chat.send` gains `model?`/`effort?` (rejected without `engine`); choice laid over a settings copy per request (`packages/core/src/summaries/model-choice.ts`), never written; CLI invalid values fall back to Settings, API blank/whitespace falls back, Local not-downloaded → existing needs-setup. `chat.getEngineChoices` → `{defaultEngine, engines:[{engine, readiness, models:{id,label}[], effortOptions, defaultModel, defaultEffort}]}` via `readEngineChoices` (no hardware detection; shared `readEngineAccess`). RED: 13 failing tests, then GREEN; core 916, contracts 82, desktop chat/ipc 351 passed; typecheck exit 0. Parent spot check: core summaries + engine-choices 517 passed.
- [x] C2 Picker UI. Route: delegated writer. Commit `eb91e11`. `ChatModelPicker.tsx` (chip `BtnChatModel` + Base UI Popover dialog with search combobox → listbox, groups, unready engine rows as single actionable options), `use-model-choice.ts`, pure `model-choice.ts`, `ui/Popover.tsx`, `ui/StepBar.tsx` (effort radiogroup); composer = textarea on top + toolbar; override sent only when changed from defaults; saved prompt engine still wins; picked choice returning setup-required never runs the gate. 18 EN/ES keys. RED → GREEN; renderer vitest 1694 passed; typecheck exit 0. Accepted: picking keeps the popup open so effort stays reachable.
- [x] C3 Settings deep link. Route: same writer. Commit `4077698`. Renderer store `features/settings/engine-focus.ts` (navigation only carries a page tag), row opened, scrolled and focused, active engine unchanged. 3 tests.
- [x] C4 E2E + visual + detector. Route: delegated writer + parent visual check. Commits `a8c6d98` (popup anchored to the composer box, `side="top"`, `align="end"`, 8px gap, height capped to available space; list `tabIndex=-1`; full row names fix axe `label-content-name-mismatch`) and `c528ba0` (`e2e/chat-model-picker.spec.ts`, 4 tests: groups/actions, override in prompt log with Settings unchanged, popup above composer, Add key deep link, New chat reset, axe light/dark). Parent: chat + summaries + settings-provider e2e 55 passed / 8 opt-in skips before C4; picker spec rerun 4 passed; detector no findings; screenshots light/dark reviewed. Gap: short-panel shrink untested.

## Checks
Focused vitest (`packages/core/src/chat`, `packages/core/src/summaries`, contracts, `apps/desktop/src/main/chat`, `src/main/ipc/chat-handlers.test.ts`, `src/renderer/features/chat`); `pnpm typecheck`; eslint + prettier on touched paths; after `pnpm build`, e2e `chat-*.spec.ts`, `summaries-*.spec.ts`.

## Progress
- 2026-11-12: research, scope decision (A), mapping; branch created.
- 2026-11-12: C1–C4 done.

## Next step
User review in the running app, then local merge into main (after `feat/summary-provider-rework`, which this branch contains).
