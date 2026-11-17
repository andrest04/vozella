# Feature: purge-winui

## Objective
Remove every WinUI/.NET reference and compatibility layer from Vozella (user decision 2026-11-17). Stack is Electron/TypeScript + minimal Rust.

## Scope
Code, tests, fixtures, comments, docs (incl. AGENTS.md, docs/port), Rust addon. Keep only: user-data safety (never touch real Documents\MeetingLive / Vozella folders in dev/tests) and the stored meeting link scheme https://meetinglive.local/meeting/ (stored in user chats/notes). Legacy MeetingLive data-folder detection: map decides; keep only if removing it can lose user data.

## Tasks
- [ ] W0 Map and plan work units (sequential, each keeps the repo green)
- [ ] W1..Wn Purge units (sequential writer, main checkout)
- [ ] W-review Parallel review (completeness sweep + behavior/data safety) and one fix round
- [ ] W-final pnpm check + e2e

## Progress / evidence
