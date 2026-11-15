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
- Not verified (settle with the real test, T4): per-word field names (`word`, `punctuated_word`, `start`, `end`), the handshake status for a bad key, any `retry-after`, whether KeepAlive alone holds the socket before the first audio frame, key format.

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

- [ ] **T1 Provider declaration and settings.** Deepgram as a transcription-only kind: key storage, key verification, engine tables, contracts enum, settings, engine choice row, brand mark, strings. It must not show in any summary or chat list. Checks: unit tests for tables, derivations, settings, renderer section; typecheck; lint. Route: delegated (many files).
- [ ] **T2 Streaming seam, Deepgram adapters and fakes.** Core streaming port, platform WebSocket `AsrEngine`/`AsrStream` (interim/final mapping, KeepAlive, drain, cancel, close-code mapping, lost audio), prerecorded `SpeechToTextClient` (raw body in `api-http`), streaming fake. Checks: unit tests against a scripted socket; typecheck; lint. Route: delegated.
- [ ] **T3 Wiring, live behavior and e2e.** Runtime and composition select the streaming engine for live and the prerecorded client for offline; live failure notice; `liveDraftIsFinal`; e2e with the fake; spec docs. Checks: unit tests, affected e2e specs, typecheck, lint. Route: delegated.
- [ ] **T4 Real endpoint proof and review.** Opt-in live test (rejected key, real stream, real prerecorded) with a key the user supplies; independent review; fix what it finds; merge and push. Route: delegated verifier plus inline.

## Acceptance

- With Deepgram selected and a key stored, a live recording shows text that updates within about a second of speech, and Stop does not upload the audio again when nothing was lost.
- Without a key the Record gate explains it; a rejected key or no funds stops live text with the existing notice and keeps the audio.
- Deepgram is absent from every summary and chat engine list.
- typecheck, lint, unit suites and affected e2e specs pass.

## Progress

- 2026-11-15: feature document created after codebase mapping and Deepgram docs research; 4 tasks.

## Next step

T1.
