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
- [ ] T2 — Cloud transcription client (route: delegated; trigger: 2+ non-trivial files)
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

- [ ] T5 — One declaration per API provider (route: delegated; trigger: refactor across core, contracts, renderer). Runs right after T1, before T2.
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

## Next step

T2.
