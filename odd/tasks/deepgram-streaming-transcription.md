# Deepgram streaming transcription

Locator: `odd/tasks/deepgram-streaming-transcription.md` · Engram mirror: `odd/deepgram-streaming-transcription/tasks` · Branch: `feat/deepgram-streaming-transcription` (from `main` at `2507338`).

## Objective

Add Deepgram as a third cloud transcription engine that streams: one WebSocket per live recording, text appearing word by word, with the user's own key.

## Problem and why

The cloud engines built in `odd/tasks/cloud-transcription-byok.md` (Groq, OpenAI) have no streaming endpoint, so live text arrives in pieces of about 15 seconds. The user tried Groq, prefers the feel of the local streaming model, and asked for a streaming cloud option. The user chose Deepgram (2026-11-15). ElevenLabs Scribe v2 Realtime was discussed as a later candidate, so the streaming adapter seam must not be Deepgram-shaped.

## Verified facts (Deepgram docs, 2026-11-15)

- Live: `wss://api.deepgram.com/v1/listen`, `Authorization: Token <key>`; query `model=nova-3`, `encoding=linear16`, `sample_rate`, `channels=1`, `language`, `interim_results=true`, `punctuate`/`smart_format`, `endpointing`.
- Client text frames `{"type":"KeepAlive"}`, `{"type":"Finalize"}`, `{"type":"CloseStream"}`; binary frames are audio. Server `Results` (`is_final`, `speech_final`, `from_finalize`, `start`, `duration`, `channel.alternatives[0].transcript|words[]`), `Metadata`, `UtteranceEnd`, `SpeechStarted`, `Error`.
- The server closes after 10 s without audio or KeepAlive (1011 NET-0001); send KeepAlive every 3 to 5 s. 1008 DATA-0000 means undecodable audio. Fatal failures may close without an `Error` message.
- Prerecorded: `POST https://api.deepgram.com/v1/listen` with a raw `audio/wav` body, up to 2 GB, 504 after 10 min of processing.
- REST errors: 401 `INVALID_AUTH`, 402 `ASR_PAYMENT_REQUIRED`, 429 `TOO_MANY_REQUESTS`. Key check: `GET https://api.deepgram.com/v1/projects`.
- nova-3 languages include `es`, `es-419`, `en`, and `multi` (code-switching, `endpointing=100` recommended). Streaming $0.0048/min monolingual, $0.0058/min multilingual; prerecorded $0.0043/min. New accounts get $200 credit.
- Not verified: any `retry-after` on a 429, the 402 body, key format.

## Observed against the real API (probe with the user's key, 2026-11-15, Node 24 global `WebSocket`)

- `GET /v1/projects`: 200 for the real key; 401 with body `{"category":"UNAUTHORIZED",...}` for an unknown key; no `retry-after` header.
- `POST /v1/listen` with a raw `audio/wav` body: 200; unknown key 401 `{"err_code":"INVALID_AUTH",...}`. Words are `{word, start, end, confidence, punctuated_word}` with times in float seconds; `metadata.duration` is the audio length in seconds.
- WebSocket: `new WebSocket(url, { headers: { Authorization: 'Token <key>' } })` opens in about 470 ms, so no `ws` dependency is needed (the `['token', key]` subprotocol opens too). An unknown key never opens: an `error` event, then `close` with code 1006 and an empty reason after about 320 ms, with no HTTP status visible.
- `Results` keys: `type, channel_index, duration, start, is_final, speech_final, channel, metadata, from_finalize`. Interim results repeat the same `start` with a growing `duration`; the final replaces them and the next segment starts at `start + duration`. Word times are absolute seconds from the start of the stream. An interim can carry zero words and an empty transcript.
- End of stream: `Finalize` returned a `from_finalize: true` final within about 160 ms; `CloseStream` returned a last empty final, a `Metadata` message whose `duration` is the total audio received, then `close` with code 1000.
- Silence: a `KeepAlive` text frame every 4 s with no audio at all kept the socket open for 25 s.
- Latency at real-time pacing with 100 ms frames: results arrive about 0.2 to 1 s behind the speech.

## Scope

- Deepgram as a transcription-only provider: it has a stored key and appears in the transcription engine choice, and it never appears as a summary or chat engine.
- A provider-neutral streaming seam in core, a Deepgram WebSocket adapter in platform (Node global `WebSocket`, no SDK; add `ws` only if the global cannot authenticate), and a streaming fake for tests and e2e.
- Live pass: interim results rewrite, final results commit, KeepAlive while silent, `drain()` sends Finalize/CloseStream and reports real `lostMs` so the pass after Stop is skipped when nothing was lost (`liveDraftIsFinal`).
- Pass after Stop and imported files: Deepgram prerecorded endpoint behind the existing `CloudSpeechEngine` chunking and retry.
- Failures: bad key, no funds, rate limit, dropped connection mapped to the existing `ApiProviderError` kinds and the existing live failure notice.
- Settings UI: engine choice row with the Deepgram brand mark, key field with verify, key guide, strings in English and Spanish.

Out of scope: diarization through Deepgram, Flux (`/v2/listen`), ElevenLabs, reconnecting a dropped live socket mid-recording (the lost audio is counted and the pass after Stop covers it), hosted keys.

## Constraints

- Dependency direction desktop → platform → core; contracts cannot import core.
- Never point dev or tests at the user's real data folders; never read the stored key file; never print a key.
- Test first where a runnable deterministic test exists. No AI attribution in commits. Technical artifacts in English.
- Delivery: solo project, no PRs; merge to `main` and push when done and working (standing user authorization). Delivery strategy `exception-ok`: forecast about 2,500 authored lines.

## Tasks

- [x] **T1 Provider declaration and settings.** Deepgram as a transcription-only kind: key storage, key verification, engine tables, contracts enum, settings, engine choice row, brand mark, strings. It must not show in any summary or chat list. Checks: unit tests for tables, derivations, settings, renderer section; typecheck; lint. Route: delegated (many files).
- [x] **T2 Streaming seam, Deepgram adapters and fakes.** Core streaming port, platform WebSocket `AsrEngine`/`AsrStream` (interim/final mapping, KeepAlive, drain, cancel, close-code mapping, lost audio), prerecorded `SpeechToTextClient` (raw body in `api-http`), streaming fake. Checks: unit tests against a scripted socket; typecheck; lint. Route: delegated.
- [ ] **T3 Wiring, live behavior and e2e.** Runtime and composition select the streaming engine for live and the prerecorded client for offline; live failure notice; `liveDraftIsFinal`; e2e with the fake; spec docs. Checks: unit tests, affected e2e specs, typecheck, lint. Route: delegated.
- [ ] **T4 Real endpoint proof and review.** Opt-in live test (rejected key, real stream, real prerecorded) with a key the user supplies; independent review; fix what it finds; merge and push. Route: delegated verifier plus inline.

## Design decisions

- **T1, how Deepgram is declared: a separate transcription-only provider table (option b), not a capability flag on `API_ENGINES`.** `ApiProviderKind` means "summary and chat engine" in about 60 files (records keyed by it, the summary resolver, the chat picker, the wizard, the contracts enums). A row there would have to be filtered out of every one of those derivations, and a missed filter would show Deepgram as a summary engine. Instead `TRANSCRIPTION_PROVIDERS` (core, `settings/transcription-provider-table.ts`) holds the name, endpoint and key check; `CLOUD_TRANSCRIPTION_ENGINES` gains the Deepgram row; `cloudTranscriptionProvider(kind)` answers the name, endpoint and key kind from whichever table holds the kind. No API engine list changes, so absence from summaries, chat and the wizard holds by construction and `api-provider-edit-points.test.tsx` asserts it. The next transcription-only provider (ElevenLabs) is one row in each of the two tables, its kind in contracts, its name in both locales and its mark.
- **T1, the key: same store, own channels.** `ApiKeyStore` takes `ApiKeyKind = ApiProviderKind | TranscriptionProviderKind`. The settings key channels stay typed to API engines; a transcription-only key travels on `transcription.setProviderKey`, `transcription.clearProviderKey` and `transcription.verifyProviderKey`, served by `TranscriptionProviderKeys` (platform, `api-keys/`). Trade-off: two command paths for one key row in the UI (`use-settings-page` picks the channel by kind) in exchange for leaving `ApiKeySettings.verify`, which lists chat models, untouched. Folding both into `ApiKeySettings` is possible later; it lives in `packages/platform/src/settings/settings-runtime.ts`.
- **T1, the page:** `SettingsPageDto.transcriptionKeys` says per cloud engine whether its key is saved, so the Transcription section reads every key flag from one place.
- **T1, temporary guard for T3 to remove:** `UnavailableSpeechEngineProvider` (platform, `transcription-runtime.ts`, returned by `TranscriptionRuntime.engine()` for a protocol other than `openai-audio-transcriptions`), the `unavailable` value of `EngineStatusDto.cloudNotReadyReason`, the `cloudNotReadyReason` helper and the branch in `notReadyMessage` (desktop, `transcription-controller.ts`), the `unavailable` prop of `CloudEngineSetup`, `cloudUnavailable` in `TranscriptionSection`, and the string `Ui_CloudEngineUnavailable`.
- **T2, the seam: a session port in core, not a socket port (Adapter plus one engine).** What varies between streaming providers is the wire (URL, auth, message names, how a stream is finished); what must not vary is buffering before the open, the mapping to `AsrResult`, lost-audio accounting and the drain at Stop. So the port (`StreamingSpeechProvider`, core `transcription/streaming-speech.ts`) is cut above the wire: `open({ language, sampleRate, cancel }, listener)` returns a `StreamingSpeechSession` (`send`, `finish`, `close`) and the listener hears `opened`, `interim`, `final`, `closed(error | null)`. A result is `{ text, words[] (ms from the first sample sent), processedMs }`. `StreamingSpeechEngine` (core, `streaming-speech-engine.ts`) adapts any provider to `AsrEngine`. ElevenLabs Scribe v2 Realtime is a second adapter in platform and one `case` in `createStreamingSpeechProvider`; the engine does not change. Rejected: a generic WebSocket port in core with the Deepgram protocol above it, which would put every provider's message handling in core and leave nothing provider-neutral to reuse.
- **T2, what "lost" means.** The engine counts three things: waiting audio dropped before the open (buffer of 30 s; the result times are shifted by it), audio sent after the last *final* result of a session that failed (an interim is not a confirmation), and audio pushed after a failure or after the drain began. A session that ends with `closed(null)` after `finish` has answered for everything it was sent, so nothing is added and a clean take drains with exactly `lostMs: 0`. The Deepgram adapter says `closed(null)` only at the `Metadata` message after `CloseStream`, or at close code 1000 while finishing.
- **T2, offline profile.** `StreamingSpeechEngine.createRecognizer({ latency: 'offline' })` rejects. A streaming session listens at the speed of speech, so recorded audio goes to `createCloudSpeechToTextClient` behind `CloudSpeechEngine`; T3 routes by latency where it selects the engine.
- **T2, a socket that never opens.** The global `WebSocket` gives close 1006 with no HTTP status for a refused key and for a dead network alike. The adapter then calls the injected `checkKey` (the factory passes `verifyTranscriptionProviderKey`, the `GET /v1/projects` of Verify, with an 8 s timeout): its failure is the reason, and an accepted key leaves `Network`. Not verified: how a funded-out account presents on the socket; if it is also a bare 1006 the key check answers 200 and the live pass ends as `Network` (no notice, the pass after Stop then fails with 402 and says so).
- **T2, timers.** The engine and the adapter wait through `CloudSpeechTimer`. Their waits are open-ended loops or timeouts, so tests drive them with `ManualSpeechTimer`; `FakeSpeechTimer` resolves every wait at once and would time a session out at once and spin the KeepAlive loop. `FakeStreamingSpeechProvider` with no delay opens and answers inside the call, so it works behind either timer.
- **T2, the factory moved.** `createCloudSpeechToTextClient` left `openai-speech-to-text-client.ts` for `cloud-speech-factory.ts` (platform), where it switches on `CloudTranscriptionProtocol` beside `createStreamingSpeechProvider`; the package export is unchanged, so `compose-transcription.ts` did not change.

## Acceptance

- With Deepgram selected and a key stored, a live recording shows text that updates within about a second of speech, and Stop does not upload the audio again when nothing was lost.
- Without a key the Record gate explains it; a rejected key or no funds stops live text with the existing notice and keeps the audio.
- Deepgram is absent from every summary and chat engine list.
- typecheck, lint, unit suites and affected e2e specs pass.

## Progress

- 2026-11-15: feature document created after codebase mapping and Deepgram docs research; 4 tasks.
- 2026-11-15: T1 done. Route: delegated writer; the parent applied the two type-only fixes the writer found outside its surfaces (`cloud-speech-services.test.ts`, `real-speech-to-text.integration.test.ts`) and replaced the placeholder icon with the Deepgram mark from simple-icons 16.38.0 (CC0-1.0). Design: separate transcription-only provider table, same key store, own key channels (see Design decisions). Observed: `pnpm typecheck` and `pnpm lint` clean; core 2576 tests, contracts 90, platform 708 (28 skipped), desktop 2659 (6 skipped) passing. One desktop run showed a single failure that did not repeat in three further full runs and was not identified. About 1,700 authored lines, most of them tests.
  - Limitations: the Record gate (core `recording/setup-snapshot.ts`) words a selected Deepgram as a missing key even when the key is saved, until T3 wires the engine. `FakeApiKeyStore` (platform `fakes/`) is still typed to API engine kinds; it stores any kind at run time and tests reach Deepgram through the `ApiKeyStore` port. No e2e spec was run.
- 2026-11-15: real API probed with the user's key before T2 (see Observed against the real API).
- 2026-11-15: T2 done. Route: delegated writer, test first. Design: a provider-neutral session port in core (`StreamingSpeechProvider`) with one engine (`StreamingSpeechEngine`) that adapts any provider to `AsrEngine`; Deepgram live and prerecorded adapters, a raw-bytes body in `api-http`, a streaming fake and a scripted socket in platform; `createCloudSpeechToTextClient` now switches on the protocol and `createStreamingSpeechProvider` sits beside it (see Design decisions). Nothing is wired: `TranscriptionRuntime.engine()` and its T1 guard are untouched, and no desktop file changed. Observed: `pnpm typecheck` clean; `pnpm lint` clean after formatting six new files with Prettier; core 2607 tests (31 new), contracts 90, platform 857 (149 new, 28 skipped), desktop 2659 (6 skipped), no failure in any run. RED was observed for the engine, the raw body, the prerecorded client, the live adapter, the streaming fake, the factory and the widened key store (missing module or failing assertions before the code existed); the pure helpers of `deepgram-listen.ts` and the already-cancelled-pass case of the live adapter were written together with their tests. About 3,500 authored lines, about 1,900 of them tests. No real socket, request or timer in any test.
  - What T3 wires: `new StreamingSpeechEngine({ provider, timer, onLost })` for the live pass with `createStreamingSpeechProvider({ keys, timer, fetch?, socket? }, { kind, settings, model })` (null for Groq and OpenAI), and `createCloudSpeechToTextClient` behind `CloudSpeechEngine` for the offline profile. In the fake native build: `new FakeStreamingSpeechProvider(fakeStreamingSpeechOptionsFromEnv(env), timer)` (`VOZELLA_FAKE_STREAM_DELAY_MS`, `VOZELLA_FAKE_STREAM_FAIL`).
  - Limitations: not run against the real API (T4). `globalLiveSocket` relies on the runtime's `WebSocket` taking a `headers` option, observed on Node 24 and not yet inside Electron's main process. The engine and the live adapter need a timer that really waits (`systemSpeechTimer`, or `ManualSpeechTimer` in tests), not `FakeSpeechTimer`. Audio sent to an open socket is not bounded on this side if the network stalls; the server's 10 s rule or the TCP timeout ends such a session. `compose-transcription.ts` passes `settings.cloudTranscriptionModelId` for every kind: T3 must make sure a model id saved for another provider does not reach Deepgram. Languages other than Spanish and English go to `multi`, which Deepgram's docs do not list for Chinese.

## Next step

T3: wire the streaming engine for the live pass and the prerecorded client for the offline pass in `TranscriptionRuntime.engine()` and `compose-transcription.ts`, remove the T1 guard, then the live notice, `liveDraftIsFinal`, e2e with the fake and the spec.
