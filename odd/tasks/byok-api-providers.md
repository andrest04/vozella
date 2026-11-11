# BYOK API providers

## Objective

Let users run summaries, chat and live answers with their own API key for OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, LM Studio), next to the existing Local, Claude Code and Codex engines.

## Problem / why

Today the only cloud engines are the Claude Code and Codex CLIs, which need the CLI installed plus a subscription. Users with a plain API key cannot use it. Competitor research (Anarlog/Hyprnote, Meetily, MacWhisper, Superwhisper) shows BYOK is standard for local-first meeting apps; Granola is the notable exception.

## Scope

- Four new summary-provider kinds backed by two HTTP protocols:
  - OpenAI chat-completions protocol: `OpenAi`, `Gemini` (Google's OpenAI-compatible endpoint), `OpenAiCompatible` (user base URL, key optional).
  - Anthropic Messages protocol: `Anthropic`.
- Keys encrypted at rest with Electron `safeStorage`, held only in the main process; the renderer only sees "key set / not set".
- Settings: key field, Verify (lists models with the key and fills the model picker), free-text model fallback, base URL for the compatible kind, notice that transcript text leaves the device.
- Transcription stays local (out of scope). Web search for live answers stays CLI-only. Image attachments are not sent to API engines in v1.
- BYOK is free (no gating).

## Constraints

- `core` stays free of Electron and Node I/O; HTTP adapters live in `packages/platform`; `safeStorage` adapter lives in `apps/desktop/src/main`.
- Every new setting field is port-only and goes in `OMITTED_WHEN_NULL` so the legacy settings file stays readable.
- All UI strings in both locales (`en`/`es`, `ui.en`/`ui.es`), key parity enforced by tests.
- Unit tests use fakes (fake fetch, fake secret store); no real accounts or network.
- Skills per AGENTS.md: `design-patterns`, `electron-best-practices`, `vitest`, `frontend-design`, `impeccable`, `accessibility`, `playwright-best-practices`, `work-unit-commits`.

## Delivery

- Strategy: single feature branch `feat/byok-api-providers`, merged to `main` (solo project, no PRs). Forecast ~1500 authored lines across 4 work units.
- RDD: off (global), so no native review; ordinary checks only.

## Tasks

- [x] T1 — Core domain (route: delegated; trigger: 2+ non-trivial files, mapping evidence > inline budget)
  - API engine table (`api-providers.ts`) parallel to `CLI_ENGINES`; new kinds, provider ids, settings fields (model per engine, compatible base URL/model), `OMITTED_WHEN_NULL`.
  - Factory/resolver route API kinds to an injected API provider builder; new resolution reason `key-missing`.
  - Remote-engine budgets: chat/context/prompt/attachments treat API engines like CLI engines (large budgets, no map-reduce).
  - API failure kinds (KeyMissing, KeyInvalid, QuotaExceeded, RateLimited, Network, TimedOut, EmptyOutput, Unknown) and message keys.
  - Readiness, setup snapshot, web policy, summary stage display names, chat engine list.
  - `SecretStore` port in core (get/set/delete per provider + has).
  - Contracts zod schemas updated.
  - Checks: `pnpm typecheck`, `pnpm --filter @vozella/core test`, `pnpm --filter @vozella/contracts test`.
- [x] T2 — Platform HTTP providers + secret storage (route: delegated; trigger: 2+ non-trivial files)
  - `OpenAiChatProvider` and `AnthropicMessagesProvider` implementing `SummaryProvider` with SSE streaming, cancel via AbortController, HTTP status → API failure kind mapping, `listModels`.
  - `safeStorage`-backed `SecretStore` in main (encrypted file under the data root), fake store in platform fakes.
  - Wire into `summary-runtime.ts` / `compose-summaries.ts`; fake mode maps API kinds to `FakeSummaryProvider`.
  - Checks: `pnpm typecheck`, platform + desktop unit tests with fake fetch.
- [x] T3 — IPC + Settings UI + renderer gates (route: delegated; trigger: 2+ non-trivial files)
  - Channels: set/clear key, verify (list models), set API option (model, base URL); page schema exposes key-set flags only.
  - `ProviderSection` radios and API options block; privacy notice; renderer gates (`use-provider-gate`, `ProviderMark`, `EngineChooser`, `wizard-state`, `cli-hint`, `use-chat`).
  - i18n keys in both locales.
  - Checks: `pnpm check`; focused e2e for settings provider section.
- [x] T4 — Specs and docs, plus T3 gap B (route: delegated; trigger: 2+ non-trivial files, reading that prepares a write)
  - `docs/port/specs/summaries.md` (§2.1, §2.5, §2.7, §2.9, §4.1, §5.2), `settings-i18n.md` §2.2, `stack.md` credentials row.
  - Gap B: the recording setup checklist no longer reopens when the wizard sends the user to Settings for an API key.
- [ ] T5 — Gap A: `Ui_SummaryProviderXaiRemoved` copy should also name the API key engines (blocked: needs `features/settings/SettingsRoute.test.tsx` and `e2e/settings-provider.spec.ts`, which also assert the old text).

## Acceptance criteria

- Selecting OpenAI/Anthropic/Gemini/Compatible with a valid key produces summaries, chat replies and live answers.
- Missing key → clear "add your API key" gate, never a CLI-missing message.
- Invalid key / quota / rate limit → specific, localized errors.
- Keys never appear in settings JSON, logs, IPC payloads to the renderer, or the library.
- `pnpm check` green; e2e for settings and summaries green.

## Progress

- Branch created. Research and mapping done (see Engram `odd/byok-api-providers/tasks`).
- T1 done: `API_ENGINES` table, `ApiKeyStore` port (`core/src/api-keys`, the `secrets` folder name is blocked by local permissions), injected `ApiProviderBuilder`, resolver reasons `key-missing` / `base-url-missing`, `setApiOption`, `ApiProviderError` + `apiFailureFromHttpStatus`, remote budgets, readiness, contracts. Checks: `pnpm typecheck` ok, `pnpm lint` ok, `pnpm test` ok (core 2280, contracts 72, platform 537, desktop 2397). Commit: see git log `feat(core): add API key summary provider kinds`.
- Deferred to T3: saved prompts naming an API engine (`CHAT_ENGINES` / `chatEngineSchema`) needs `renderer/features/chat/chat-prompts-view.ts` labels; T2/T3 must wire `apiKeys` + `apiProviderBuilder` in `summary-runtime`, `apiKeys` in `SettingsPageService`, `apiKeySet` in `compose-recording.ts`, and register `settings.setApiOption` in `channels.ts`.

- T2 done: `packages/platform/src/api-providers/` (`OpenAiChatProvider`, `AnthropicMessagesProvider` on a shared `ApiChatProvider` base, `createSseParser`, `apiBody`/`apiJson` with cancel → `CancelledError`, idle timeout → `TimedOut`, wire errors → `Network`, non-2xx → `apiFailureFromHttpStatus`, key scrubbed from details; `listApiModels`; `createApiProviderBuilder`), `FakeApiKeyStore` + `FakeFetch` in platform fakes, `SummaryRuntime` uses the real builder over the injected `apiKeys`. Desktop: `SafeStorageKeyStore` (`<app data>/api-keys.bin`, base64 of safeStorage-encrypted JSON, atomic serialized writes, unavailable encryption → `set` throws / `has` false), `composeApiKeys` (fake store in fake native build), one store created in `main/index.ts` and passed to `composeSummaries` (exposed as `ComposedSummaries.apiKeys`) and `composeRecording` (`apiKeySet`). RED observed (modules missing) then GREEN. Checks: `pnpm typecheck` ok, `pnpm lint` ok, `pnpm test`: core 2280, contracts 72, platform 583 ok; desktop 2405 ok on rerun (first runs had load-induced renderer timeouts and the known flaky Range-resume download test, both green in isolation). Commits: `700aee9` feat(platform), plus feat(desktop) (see git log).
- Open gap for T3: `SettingsPageService` is built inside `packages/platform/src/settings/settings-runtime.ts` (outside the T2 edit surface), so `SettingsRuntimeDeps` still needs an `apiKeys` field passed through from `composeSettings`; until then the Settings page reports every key as not set.

- T3 done: `SettingsRuntimeDeps.apiKeys`/`fetch`/`verifyTimeoutMs` and `SettingsRuntime.apiKeys` (`ApiKeySettings`: set/clear answer `{status, keySet}`, verify answers `{status:'verified', models}` or `{status:'failed', errorKey}` from `API_FAILURE_UI_KEYS` / `API_KEY_SETTINGS_UI_KEYS`, 20 s timeout); `composeSettings` gets the shared store and, in the fake native build, a `FakeFetch` model list. Channels `settings.setApiOption` (registered), `settings.setApiKey`, `settings.clearApiKey`, `settings.verifyApiKey` (strict zod; the key is never in an answer or log). Settings: `ProviderChoice` (one radiogroup, three captioned rows: on this PC / with a subscription / with your API key), `ApiProviderOptions` (privacy notice, server address for the compatible kind, masked key with show/hide, Save/Verify/Remove, polite live status line, model input with datalist of verified + catalog ids). Gates: wizard chooser lists the API engines (`SavingApi` phase: save, then ready or open Settings), provider gate shows "Add your API key in Settings" notice (also in chat), saved prompts can name API engines. RED observed for contracts, runtime, handlers, Settings UI, gate and wizard reducer, then GREEN. Commits: see git log (`feat(desktop): add API key IPC channels`, `feat(settings): add API key provider settings`, `feat(desktop): offer API key engines in the wizard, gate and saved prompts`).
- T3 gaps: `Ui_SummaryProviderXaiRemoved` copy unchanged (needs `apps/desktop/src/renderer/features/summaries/SummaryGeneration.test.tsx`, outside the T3 surface); `features/record/use-ensure-ready.tsx` re-shows the checklist after the wizard sends the user to Settings for a key; the ai-provider `ModelPicker` is the local GGUF list, so the API model uses an input with suggestions instead.

- T4 done. Gap B fixed: `SetupWizardDialog` / `useSetupWizard` take an optional `onSentToSettings`, called just before `onFinished(null)` when an API engine still needs its key; `useEnsureReady` maps the wizard to `ready | left | settings` and ends the loop on `settings` (no checklist, no "Setup cancelled." notice); the checklist comes back on the next Record. RED observed in `RecordRoute.test.tsx` (the checklist dialog was still open after the wizard opened Settings), then GREEN; an ordering test was added to `SetupWizardDialog.test.tsx`. Docs describe the shipped behavior (engine table, protocols, no map-reduce, no images or web search, failure kinds and HTTP mapping, readiness reasons, Settings block, five settings fields omitted when null, `api-keys.bin` boundary). Gap A deferred to T5 (edit surface). Commits: see git log (`fix(record): keep setup checklist closed while adding an API key`, `docs(summaries): document API key providers`).

## Next step

T5 (gap A copy, needs the two extra test files authorized), then a manual smoke with a real key by the user, then merge to main.
