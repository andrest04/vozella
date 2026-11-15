# Cloud transcription (BYOK)

## Objective

Let users who cannot run the local speech engine transcribe meetings with their own API key, through the OpenAI-compatible `POST /audio/transcriptions` endpoint of Groq or OpenAI, next to the existing local engine.

## Problem / why

Transcription is local only: it needs the Nemotron model plus a CPU or CUDA runtime on disk, and Record is gated on it. Users on weak machines cannot use the app at all, even though summaries, chat and live answers already work with an API key. Research on 2026-11-15: every competitor that serves weak machines is hosted ($8-20/month); Meetily, the closest local-first rival, has the same gap. Groq `whisper-large-v3-turbo` costs $0.04 per audio hour, its endpoint is OpenAI-compatible, and the same key serves chat models, so one key can cover transcription and summaries. Subscription sign-in (OAuth) does not cover speech-to-text on any provider, and Anthropic and Google prohibit it for third-party apps, so it is out of scope.

## Scope

- `Groq` becomes a first-class API engine (key, Verify, model picker) for summaries, chat and live answers, so one key covers everything. Today Groq is only reachable through `OpenAiCompatible` with a custom base URL.
- New setting: transcription engine, one of `Local` (default), `Groq`, `OpenAi`, plus the cloud transcription model. The cloud engines reuse the key already stored for that provider kind.
- A cloud speech engine behind the existing `AsrEngine` port: it buffers pushed PCM, cuts chunks (preferring a quiet point), uploads each chunk as WAV, and maps word timestamps with the chunk offset into `AsrResult`. The same adapter serves the live pass and the offline pass.
- Live transcription in cloud mode is near-live: text arrives one chunk behind (about 15 s).
- Revised 2026-11-15 after reading the provider limits: in cloud mode the audio is not uploaded twice. When the live pass covered the whole recording with no failed chunk, its transcript is the final one; the pass after Stop runs only for imports, re-transcription, live transcription turned off, or gaps. Reason: Groq's developer tier allows 20 requests per minute and 7,200 audio seconds per hour for the whisper models, so a second pass over a long meeting would be throttled for up to an hour.
- The offline pass uses longer chunks (up to about 60 s) and a client-side limiter that honors `retry-after`; billing exhaustion (OpenAI 429 with `insufficient_quota` or `credit_balance_exhausted`) is never retried.
- Models: Groq `whisper-large-v3-turbo` (default) and `whisper-large-v3`; OpenAI `whisper-1`, the only OpenAI model documented with word timestamps. OpenAI lists `whisper-1` as deprecated with shutdown on 2027-02-26, so the model id stays configurable and a response without `words[]` falls back to segment timestamps.
- Readiness: with a cloud engine selected, transcription is ready when the key is set; nothing is downloaded. Record and re-transcription are gated on that.
- Settings UI: engine choice in the Transcription section, key entry and Verify reused from the API engines, a notice that meeting audio leaves the device, and a short "get a key" guide.
- Speaker labels (diarization) are unavailable in cloud mode in v1: the endpoint returns no speakers.

## Out of scope

- A hosted transcription service paid by Vozella (accounts, quotas, billing).
- Subscription sign-in (OAuth) of any provider.
- Real-time streaming providers (Deepgram, AssemblyAI, ElevenLabs).
- Audio compression before upload; chunks are small PCM16 WAV files.

## Constraints

- `core` stays free of Electron and Node I/O; HTTP adapters live in `packages/platform`.
- Every new setting field is port-only and goes in `OMITTED_WHEN_NULL` so the legacy settings file stays readable.
- All UI strings in both locales, key parity enforced by `i18n-catalog-checks.test.ts`.
- Unit tests use fakes (fake fetch, fake key store, fake ASR); no real accounts or network. Dev and tests never touch the real data folders.
- Provider facts (base URLs, model ids, response fields, limits) are taken from the official docs at implementation time, never from memory.
- Skills per AGENTS.md: `design-patterns`, `electron-best-practices`, `vitest`, `frontend-design`, `impeccable`, `accessibility`, `playwright-best-practices`, `work-unit-commits`.

## Delivery

- Strategy: `single-pr` equivalent for this solo project: one feature branch `feat/cloud-transcription-byok`, merged to `main` by the user's decision (no PRs). Forecast about 1,600 authored lines across 4 work units; over the 400-line budget, accepted because the project merges whole feature branches.
- RDD: off (global) on 2026-11-15, so no native review. After each writer returns, `gentle-ai review assess` picks the verification tier.

## Tasks

- [x] T1 — Groq as a first-class API engine (route: delegated; trigger: 2+ non-trivial files across core, contracts, renderer)
  - Add `Groq` to the provider kinds, the API engine table (OpenAI chat protocol, Groq base URL, key required), zod enums, the settings page object, engine groups, chat engine list, and both locales.
  - Model list and default model come from Groq's official docs; Verify fills the picker.
  - Acceptance: a Groq key can be saved, verified, and used for a summary and a chat prompt with fake fetch; existing engines unchanged.
  - Checks: `pnpm check`.
- [x] T2 — Cloud transcription client (route: delegated; trigger: 2+ non-trivial files)
  - Multipart support in the API HTTP helper (timeout, cancel, key scrubbing, same error mapping).
  - `transcribeAudio`: PCM16 mono chunk to WAV, `POST {baseUrl}/audio/transcriptions` with model, language, verbose JSON and word timestamps; returns text plus words with times.
  - Transcription model table per provider (Groq, OpenAI) with defaults, in core next to the API engine table.
  - Acceptance: request shape and response mapping covered with fake fetch, including key invalid, rate limited, network, timeout, empty output, and a response without word timestamps.
  - Checks: `pnpm check`.
- [ ] T3 — Cloud speech engine, settings and readiness (route: delegated; trigger: 2+ non-trivial files, design work)
  - `transcriptionEngine` and cloud model settings; contracts and status DTO carry the engine kind, with the local-only fields optional.
  - Cloud `AsrEngine` adapter: chunking with a quiet-point cut, in-order results, offsets, tail flush for the offline pass, failures surfaced as transcription errors with the API failure text.
  - Engine selection in the runtime and controller; readiness and `ensureEngine` for cloud; diarization off in cloud mode.
  - Acceptance: live and offline passes produce stamped lines from a fake cloud engine; Record is allowed with a cloud key and no local model; missing key blocks Record with a clear reason.
  - Checks: `pnpm check`.
- [ ] T4 — Settings UI, notices, guide and e2e (route: delegated; trigger: UI work across several files)
  - Engine picker in the Transcription section, key and Verify reuse, audio-leaves-the-device notice, "get a key" guide, speaker-labels note, both locales.
  - Record-gate and setup dialog texts for the cloud engine.
  - e2e: choose a cloud engine with a fake key, record, see a transcript; a11y check on the new controls.
  - Spec update in `docs/port/specs/`.
  - Checks: `pnpm check`, the touched e2e specs.

- [x] T5 — One declaration per API provider (route: delegated; trigger: refactor across core, contracts, renderer). Runs right after T1, before T2.
  - Added on 2026-11-15 at the user's request, after T1 showed that a new provider kind must be repeated in about ten places (core constants, several zod enums in `packages/contracts/src`, renderer `ai-provider` tables, wizard order).
  - Goal: adding an API provider means one entry in one table; every other list, enum, name key, icon lookup and ordering derives from it. Where the dependency direction forbids deriving, keep the copy and add a parity test that fails with the missing kind's name.
  - No behavior change: same kinds, ids, order, stored settings and strings. Existing tests stay green without edits to their expectations.
  - Acceptance: a test or documented checklist shows the edit points for a new provider; the count is lower than before T5 and is recorded here.
  - Checks: `pnpm check`, e2e `settings-api-keys` and `summaries-wizard`.

## Progress

- 2026-11-15: research and code map done; branch created; no task started.
- 2026-11-15: T1 done in the work-unit commit `feat(settings): add Groq as an API engine` (route: delegated, one writer). `Groq` is an API kind (`groq` provider id, OpenAI chat protocol, fixed base URL `https://api.groq.com/openai/v1`, key required, model setting `selectedGroqModelId`, default `llama-3.3-70b-versatile`), listed between Gemini and the compatible engine everywhere. Verify keeps vendor-prefixed ids (`openai/gpt-oss-120b`) and drops Groq's `whisper`, `guard` and `orpheus` models. The edit surface grew by user approval to `renderer/features/ai-provider/` (kind list, provider gate, provider mark) and `e2e/summaries-wizard.spec.ts`; the Groq mark is the inlined path from `@lobehub/icons-static-svg` 1.102.0 (MIT), by user decision.
  - Checks observed: `pnpm typecheck` clean; `pnpm lint` clean; `pnpm test` all passed (contracts 82, core 2352, platform 600 with 24 skipped, desktop 2528 with 6 skipped); `pnpm build` ok; `npx playwright test e2e/settings-api-keys.spec.ts` 2 passed; `npx playwright test e2e/summaries-wizard.spec.ts` 10 passed, 3 skipped (screenshots).
  - Sources (read 2026-11-15): https://console.groq.com/docs/openai (base URL), https://console.groq.com/docs/models (production models: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`; speech-to-text for T2: `whisper-large-v3`, `whisper-large-v3-turbo`).
  - Commit `e691949`. Native assessment on 2026-11-15: `medium` (`executable_change`), `review_due` false, reason `under_budget` (RDD off, no review). Parent spot check: `pnpm typecheck` clean.
- 2026-11-15: T5 done in the work-unit commit `refactor(settings): derive API provider lists from one table` (route: delegated, one writer). No behavior change: same kinds, ids, order, settings file and IPC schemas; no existing test was edited.
  - Design: the single table is core's `API_ENGINES`, moved unchanged to `packages/core/src/settings/api-engine-table.ts`. That module imports types only, so `library/settings`, `summaries/provider` and `chat/user-prompts` read it at load time without an import cycle (`api-providers` re-exports it and keeps the helpers). `ApiProviderKind`, `ApiProviderId` and the name-key union are now types of the table; `API_PROVIDER_KINDS`, `SUMMARY_PROVIDERS`, `PROVIDER_IDS`, `CHAT_ENGINES` and the model entries of `OMITTED_WHEN_NULL` derive from it; the caption switch uses `isApiProvider`. The renderer imports core, so `API_KINDS`, `API_NAME_KEYS`, the API key group of `ENGINE_GROUPS`, `SETTINGS_KIND`, `ENGINE_LABEL` and the picker group derive from the same table, and the provider gate uses `isApiKind` instead of one `case` per kind.
  - Duplication that stays: `contracts` depends on zod only and cannot import core, so `packages/contracts/src/api-providers.ts` restates the kinds and ids once; every enum (`summaryProviderSchema`, `apiProviderKindSchema`, `selectableEngineKindSchema`, `summaryApiKindSchema`, `summaryProviderIdSchema`, `chatEngineSchema`) and the page's `api` object derive from it. The settings fields stay explicit because `FIELDS` order is the persisted order (Groq sits after the compatible engine's fields, not in table order).
  - Edit points for a new provider, production code. Before: 29 places in 17 files (core 11 in 5, contracts 8 in 4, renderer 8 in 6, locales 2). After: 8 places in 7 files: (1) the row in `api-engine-table.ts`; (2) the `AppSettings` field and (3) its `FIELDS` row in `packages/core/src/library/settings.ts`; (4) the kind and id in `packages/contracts/src/api-providers.ts`; (5) the field in `appSettingsSchema` (`packages/contracts/src/library.ts`); (6) and (7) the product name in `ui.en.json` and `ui.es.json`; (8) the mark in `ProviderMark.tsx`. The compiler names (2) and (8); `api-provider-derivation.test.ts` (core) names (3); `api-provider-edit-points.test.tsx` (desktop) names (4) to (8) and lists them in its header.
  - Checked with a scratch `Dummy` engine, reverted: before the refactor the new derivation test failed on all four derived lists and the caption (RED); after it those pass with the dummy in the table only (GREEN), and with points (2), (3), (4), (5) and (8) filled in `pnpm typecheck` reports no error in production code. The locale points were not exercised: the dummy reused Groq's name key, since the locale files are outside this task's edit surface.
  - Not reduced: tests that name each engine on purpose still need the new one (fixtures and order pins in `contracts/src/settings.test.ts`; core `library/settings.test.ts`, `api-providers.test.ts`, `engine-choices.test.ts`, `page-service.test.ts`, `provider.test.ts`, `api-provider-derivation.test.ts`; desktop `SetupWizardDialog.test.tsx`, `ApiProviderOptions.test.tsx`, `SettingsRoute.test.tsx`; e2e `summaries-wizard.spec.ts`). They were left as they are because T5 forbids changing their expectations.
  - Checks observed: `pnpm typecheck` clean; `pnpm lint` clean; `pnpm test` all passed (contracts 82, core 2379, platform 600 with 24 skipped, desktop 2555 with 6 skipped; baseline before the change: 82, 2352, 600, 2528); `pnpm build` ok; `npx playwright test e2e/settings-api-keys.spec.ts` 2 passed; `npx playwright test e2e/summaries-wizard.spec.ts` 10 passed, 3 skipped (screenshots).
  - Commit `9d3c88d`. Native assessment on 2026-11-15: `medium` (`executable_change`), `review_due` false, reason `under_budget` (RDD off, no review). Parent spot check: `api-provider-derivation.test.ts` 27 passed.
- 2026-11-15: T2 done in the work-unit commit `feat(transcription): add the cloud speech-to-text client` (route: delegated, one writer). Nothing is wired: the running app behaves as before.
  - Port: `SpeechToTextClient` in `packages/core/src/transcription/speech-to-text.ts`, one method `transcribe({ samples, sampleRate, language, prompt? }, cancel)` returning `{ text, words: { text, startMs, endMs }[], durationMs }` with times from the start of the piece. T3's chunking engine depends on this alone; a provider with its own API implements only this.
  - Engine table: `CLOUD_TRANSCRIPTION_ENGINES` in `packages/core/src/settings/cloud-transcription-engines.ts` (rows `Groq`, `OpenAi`: protocol, models, model names, default, documented limits). The name, base URL and key come from the `API_ENGINES` row of the same kind (`cloudTranscriptionApiEngine`, `cloudTranscriptionBaseUrl`); `resolveCloudTranscriptionModel` keeps any saved id. An OpenAI-compatible transcription provider is one row.
  - Adapter: `OpenAiSpeechToTextClient` and the factory `createCloudSpeechToTextClient` in `packages/platform/src/transcription/openai-speech-to-text-client.ts`. It sends `file` (WAV from the new `encodePcm16Wav` in `wav-format.ts`, which reuses `buildWavHeader`), `model`, `response_format=verbose_json`, `timestamp_granularities[]=word`, `temperature=0`, `language` (bare code, omitted for `auto`) and `prompt` (the last 400 characters, cut at a word); nothing else. The key is read for every piece and a missing key fails with `KeyMissing` before any request. Fake: `FakeSpeechToTextClient` in `packages/platform/src/fakes/` (one script word per 500 ms of audio, optional delay, failure and failing calls).
  - HTTP helper: `ApiRequest.form` sends a multipart form through the same `apiBody` path as JSON (idle timeout, cancel, key scrubbing, error mapping). `ApiProviderError.retryAfterMs` is new and additive: `apiBody` fills it from `retry-after` (seconds) only when the failure is `RateLimited`, null otherwise. Quota: a 429 whose body names `insufficient_quota` or `credit_balance_exhausted` (new word in `apiFailureFromHttpStatus`) is `QuotaExceeded` with no `retryAfterMs`, so T3 never retries it.
  - File too large: no new failure kind or UI string. HTTP 413 stays `Unknown` and keeps the server text; the adapter also refuses a WAV above 25 MB before uploading, as `Unknown` with its own detail.
  - Missing `words[]`: the words of each segment are spread evenly over that segment; with no segments either, the words of the text are spread over the piece. Words are trimmed, empty ones dropped, times never negative, and a word never ends before it starts. Silence returns empty text and no words.
  - Size: about 1,375 added lines (about 570 production, about 805 tests), above the 400-line heuristic because the request, answer and failure matrix asked for is covered case by case; not split.
  - RED/GREEN: the new tests failed first (core: `encodePcm16Wav` and `retryAfterMsFromHeader` not functions, `credit_balance_exhausted` read as `RateLimited`, the table module missing; platform: adapter and fake modules missing, `retryAfterMs` undefined), then passed.
  - Checks observed: `pnpm typecheck` clean; `pnpm lint` clean; `pnpm test` all passed (contracts 82, core 2417, platform 665 with 24 skipped, desktop 2555 with 6 skipped).
  - Sources (read 2026-11-15): https://console.groq.com/docs/speech-to-text (endpoint, models, fields, 224-token prompt, 25 MB, 10 s minimum billing), https://console.groq.com/docs/errors (status codes, `{"error":{"message","type"}}`), https://console.groq.com/docs/rate-limits (`retry-after` in seconds only on 429; 20 requests per minute and 7,200 audio seconds per hour). https://platform.openai.com/docs/api-reference/audio/createTranscription answered 403 to the writer's fetch, so the OpenAI facts are the ones in the task brief.
  - Still needs a live call: whether `words[].word` carries spaces or punctuation; the text of a Groq 429 for audio seconds per hour (it must not contain `quota`, or it would read as `QuotaExceeded`); OpenAI's real `retry-after` on 429; whether `whisper-1` accepts `temperature=0` with word timestamps exactly as sent.

## Next step

T3.
