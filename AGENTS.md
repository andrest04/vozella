# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, GitHub Copilot, OpenCode, or any agent following the [agents.md](https://agents.md) convention) working in this repository.

## Product name

The product is named **Vozella**: an Electron app in `apps/desktop`, `packages/*`, and `native/*`. It began as a port of an earlier WinUI 3 app named MeetingLive, which is no longer in this repo. A few `MeetingLive` names stay on purpose; do not rename them, because that can orphan user data or break stored links:

- legacy data-folder detection (`LEGACY_FOLDER_NAME = 'MeetingLive'`, `sharesMeetingLive`) and the guard that refuses to run dev or tests against the real `MeetingLive` folders;
- the internal meeting link scheme `https://meetinglive.local/meeting/`, stored in chats and notes.

## Stack and conventions

Follow `docs/port/stack.md` (stack, layout, dependency direction, data safety, design direction, porting rules). Feature behavior is specified in `docs/port/specs/*`.

## Hard gate: every change MUST go through skills

This is not optional. **Do not write, edit, test, review, package, or ship Vozella code without first loading the matching `SKILL.md` files.** Ad-hoc implementation is a quality failure.

A new feature, a bug fix, a unit test, an e2e test, a refactor, a review, or a packaging step that skipped its skills did not happen correctly. Redo it through the skills.

Before any implementation, test, or feature work:

1. Read the skill index at `.atl/skill-registry.md` (Engram topic `skill-registry` if the file is missing).
2. Load every matching skill in the routing table below — read the exact `SKILL.md` path. Do not summarize the skill.
3. Follow that skill's procedure. If the skill cannot be loaded, **STOP** and tell the user.
4. When delegating, inject those exact `SKILL.md` paths into the sub-agent prompt under `## Skills to load before work`. The sub-agent must read them **before** task-specific work.

Project skills live in `.claude/skills/` and `.agents/skills/` (see `skills-lock.json`).

### Mandatory skill routing

| Work | Skills that MUST be loaded |
| --- | --- |
| New UI, layout, visual polish | `frontend-design`, `impeccable`, `accessibility` |
| Electron main/preload/IPC, security, windows | `electron-best-practices` |
| Installer, signing, auto-update, release | `electron-builder` |
| Unit tests (Vitest) | `vitest` |
| End-to-end tests (Playwright `_electron`) | `playwright-best-practices` |
| Rust addon (`native/vozella-native`) | `rust-best-practices` |
| Architecture, refactors | `design-patterns` |
| Commits | `work-unit-commits` |

Exact paths are in `.atl/skill-registry.md`. Example: `C:\Code\vozella\.claude\skills\vitest\SKILL.md`.

### Do not

- Skip skills because the change "looks small".
- Point dev or tests at the user's real data folders (`Documents\MeetingLive`, `Documents\Vozella`); every run sets `VOZELLA_DATA_ROOT` to a temp folder.

## Strings

User-facing text lives in `apps/desktop/src/renderer/i18n/locales/`: `en.json` / `es.json` (the strings carried over from the original app, keys unchanged) and `ui.en.json` / `ui.es.json` (the hand-written `Ui_` strings). Edit these JSON files directly; nothing generates them. Add every key to both locales with the same `{0}` placeholders — `apps/desktop/src/main/i18n-catalog-checks.test.ts` enforces key parity, order, non-empty values, and placeholder sets. Do not hardcode UI strings.

## Commands

Prerequisites: Windows x64, Node.js 24+, pnpm (pinned by `packageManager`), Rust with `cargo` and the Visual C++ build tools for the native addon.

- Install: `pnpm install`
- Run in development: `pnpm dev`
- Typecheck, lint, and unit tests: `pnpm check` (or `pnpm typecheck`, `pnpm lint`, `pnpm test` on their own)
- Build: `pnpm build` (native addon, then the app)
- End-to-end tests: `pnpm test:e2e` (builds first). A single spec, from `apps/desktop`: `npx playwright test e2e/<name>.spec.ts`
- Installer: `pnpm package` (unsigned NSIS in `apps/desktop/release/`)

## Architecture

```
apps/desktop/          Electron app
  src/main/            composition root, windows, tray, IPC handlers
  src/preload/         contextBridge exposing the typed API only
  src/renderer/        React: app/, features/<module>/, ui/ (design system), i18n/
  src/workers/         utilityProcess entries: audio, asr
packages/contracts/    zod schemas and channel definitions
packages/core/         pure domain by feature, ports as interfaces; no electron, no fs
packages/platform/     node adapters for the ports (fs, CLI, HTTP, llama, nemo) plus fakes
native/vozella-native/ Rust addon: audio, calendar, dpapi, sessions, windows
```

Dependency direction: `apps/desktop` to `platform` to `core`; `contracts` is shared. `core` never imports Electron or Node I/O. Folders name features, never `utils` or `services`. Details in `docs/port/stack.md`.

## Testing

- **Unit tests** — Vitest in every package (`pnpm test`). Providers and OS capabilities use the fakes in `packages/platform`; no real accounts or model downloads.
- **End-to-end** — Playwright `_electron` against the built app with the fake-native build flag (`apps/desktop/e2e`).
