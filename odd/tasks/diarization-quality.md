# Feature: Diarization quality (Sortformer)

Locator: `odd/tasks/diarization-quality.md` · Engram mirror: `odd/diarization-quality/tasks` · Branch: `feat/diarization-quality` · Worktree: `C:\Code\vozella-worktrees\diarization-quality` (isolated, parallel to `feat/action-item-deadlines`, approved by user 2026-11-06)

## Objective
Make speaker labels trustworthy: smooth per-word tag flicker, label the local user as "You" from the mic channel, use a documented live preset, warn about limits, and test with realistic audio.

## Why
Audit 2026-11-06: model, input format and offline preset (340/40/40/300/188 = model card "Very high latency" 30.4 s) are correct. Weak points are downstream: `packages/core/src/transcription/accumulator.ts:199` splits a line on every per-word speaker change and `:129` labels a line by its first word (tag 0 → no label); live pass uses undocumented library defaults (`asr-types.ts:39-46`); mic + system audio are mixed before diarization (`docs/port/specs/recording.md:401,931`); one synthetic real test behind `VOZELLA_REAL_ASR_NET`.

## Tasks
- [x] D1 Smooth speaker tags in the accumulator: absorb runs shorter than ~2 words / ~500 ms into neighbors, fill tag-0 words from nearest tagged word, majority label per line. Pure functions + unit tests (flicker, tag-0, single speaker). Route: delegated.
- [x] D2 Live preset: switch live diarization to the model card "Low" preset (1.04 s: chunk 6 / right ctx 7 / fifo 188 / update period 144 / cache 188), verify the native API accepts it. Route: delegated.
- [x] D3 Warnings: speaker-labels setting/meeting view explains max 4 voices and lower accuracy outside English (en/es). Route: delegated.
- [x] D4 Tests: accumulator unit tests + a realistic multi-speaker fixture plan for the real-engine test. Route: delegated.
- [x] D5 Mic as "You": keep mic vs system energy per frame (or diarize system audio only) so lines spoken into the local mic are labelled "You" and don't consume one of the 4 slots. Touches capture pipeline (Rust mixer/resampler). Route: delegated, after D1–D4 (explore first).

## Constraints
- Test first (RED→GREEN), en + es keys, `pnpm check` before each commit.
- Delivery: solo project, merge to main (no PRs). Merge after `feat/action-item-deadlines` or rebase on it if conflicts.
- Unverified: NeMo-Speech.cpp v0.3.0 defaults, meaning of 0 values, whether runtime post-processes tags.

## Progress
- 2026-11-06: worktree + branch created from main `63eb825`.
- 2026-11-07: D1 `1a4df04`, D2 `0577630`, D3 `0f42b7a`, D4 `71911db` (delegated writer). core 2051 pass, desktop 2251–2252 pass (one flaky unrelated timing test per full run: Notepad debounce / LibraryRoute; pass alone), typecheck + lint pass; parent spot check 55/55. D2 verified with the real engine (`VOZELLA_REAL_ASR=1 VOZELLA_REAL_ASR_NET=1`): Low preset accepted, 0 ms dropped. Thresholds: flicker = <2 words and <500 ms; untagged words fill only within a pause-free stretch; line label = majority (tie → first heard). Header `asr-v0.3.0.h`: 0/-1 = default, max speaker count ignored. D3 changed only the setting description (settings UI lives in `features/transcription/`, transcript view in `features/session/`, outside surface). Known limit: a returning voice whose whole result is untagged stays unlabelled → D5 mic energy can fill it.
- 2026-11-07: D5 (delegated writer): `40fb41d` mic-activity → You mapping (50 ms frames, mic RMS ≥ 0.01 and ≥ 2× system, open after 2 frames, close after 6 quiet / 2 system-louder; word ≥ 50 % inside → You, before smoothing), `ec2abaa` sidecar `<name>.mic.json` reader + frame levels, `22bb57e` capture measures mic/system before mixing + writes sidecar, `e989e72` library moves/deletes sidecar with WAV, `adae647` live + saved transcript show You/Tú (stored token `[ You ]`, English like `Speaker-N`), `01458b5` summary prompt mentions `[ You ]`. core 2110, contracts 62, platform 530, desktop 2262 pass; typecheck + lint pass; real-engine 7/7 (`VOZELLA_REAL_ASR=1 VOZELLA_REAL_ASR_NET=1`); native built with `pnpm build:native`. Not tuned against real mic echo yet (thresholds research-based). Out of scope: system-only diarization to free the 4th slot. E2E `3074c54` transcript-you-label.spec.ts 3/3 runs pass.

## Next step
E2E spec, then merge to main after `feat/action-item-deadlines` (expect a small conflict in `packages/core/src/summaries/prompt-builders.ts` and the summaries spec).
