# Feature: connect-existing-features

## Objective
Get more value out of features that already exist by connecting them, based on the 2026-11-16 feature analysis.

## Problem
Live-take output (rolling digest, detected questions, answers) is discarded at Stop; the pill/dock live-ask has almost no context; Folder/All chat reads only the 12 newest meetings; summaries ignore related meetings and the folder note; the custom note template is half-wired.

## Constraints
- AGENTS.md hard gate: load skills from .atl/skill-registry.md. core stays pure (no electron/fs). Strings in both locales.
- Test-first (Vitest) where a deterministic test exists. One writer at a time. Workflow agents run on Sonnet.
- RDD is off (global) — ordinary checks only. Delivery: merge to main only when the user asks (no PRs).
- Delivery strategy: single branch, no PR (user preference). Forecast ~1200–1800 authored lines.

## Tasks
- [x] T1 Live-ask context parity — pill/dock live-ask gets the same context as Live chat (title, notes, rolling digest, recent transcript); "What did I miss?" covers the whole take via the digest. Route: delegated (workflow writer).
- [x] T2 Keep live-take output — at Stop, carry digest + shown questions + answers into the pipeline; the summary generator receives them as context; the Q&A is saved with the meeting (appended to its notes as a "Live Q&A" block). Route: delegated. Commit 6ac56bd; verifier PASS.
- [x] T3 Relevance-ranked chat context — Folder/All chat picks meetings with the library's searchMeetings ranking for the question, then fills with most recent, still capped. Route: delegated. Commit a9223f3; verifier PASS.
- [x] T4 Series-aware summaries — summary prompt includes open action items from related meetings and the folder note. Route: delegated. Commit 49b97d0; verifier PASS.
- [x] T5 Finish custom template — Settings field for a custom note template; tab-service passes it; templateIdToStore keeps "custom". Route: delegated. Commit 376cb09; verifier PASS.

## Acceptance
Each task: new/updated Vitest tests, `pnpm check` green, one conventional commit on feat/connect-existing-features.

## Progress / evidence
All 5 tasks done via workflow wf_83b13471-3c0 (Sonnet writer + independent Sonnet verifier each; no fix rounds needed).
Parent spot check 2026-11-16: pnpm typecheck exit 0, pnpm test exit 0.
Follow-ups (not done):
- Both live-ask chips share the boolean `preset` flag, so "Explain" also gets the overview scope; splitting needs renderer change (use-live-ask.ts, ChatPanelContainer.tsx).
- Chip wording still says "last few minutes"; changing it needs ChatPanel.test.tsx updates.
- Answered question cards are paired with typed asks by text match (IPC carries only dismiss).
- Not run: e2e (pnpm test:e2e), manual run of the app.

## Next step
User tries it in the app; merge to main only when the user asks.
