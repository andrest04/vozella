# Feature: Automatic updates

Locator: `odd/tasks/auto-update.md` · Engram mirror: `odd/auto-update/tasks` · Branch: `feat/auto-update` · Worktree: `C:\Code\vozella-worktrees\auto-update`

## Objective
Installed copies of Vozella find, download and install new releases on their own, so users stop downloading every version by hand.

## Problem
- `electron-updater` is not used anywhere; the app never checks for new versions.
- `.github/workflows/release.yml` publishes only `Vozella-Setup.exe` (a fixed-name copy for the landing page link) and its `.sha256`, via `gh release create`. electron-updater's GitHub provider needs `latest.yml` and the installer file it names (plus the `.blockmap` for differential downloads) in the release.
- The installer is unsigned for now (SignPath application pending), so updates install with the same SmartScreen behavior as a first install.

## Approach (default chosen; user approved auto-update 2026-11-10)
- Packaged builds only: check GitHub Releases shortly after startup and every few hours, download in the background, and install when the app quits. When a download is ready, the app shows a quiet notice with a "Restart now" action. Dev and e2e builds never check.
- Keep the fixed-name `Vozella-Setup.exe` asset for the landing page; add the versioned installer, `latest.yml` and the blockmap to the same release.
- No new settings toggle in this feature.

## Tasks
- [x] U1 Release artifacts: `publish` config (GitHub provider) in `apps/desktop/electron-builder.config.mjs`, and `release.yml` uploads `latest.yml`, the versioned installer and its blockmap next to the existing assets.
  - Route: delegated writer. Evidence: `pnpm package` wrote `release/latest.yml` (`path: Vozella-Setup-0.9.7.exe`), `Vozella-Setup-0.9.7.exe`, `Vozella-Setup-0.9.7.exe.blockmap`, and `win-unpacked/resources/app-update.yml` (provider github, owner andrest04, repo vozella). The workflow fails the release when `latest.yml` does not name the versioned asset. YAML parses; CI not run locally. Commit: see Progress.
- [ ] U2 Updater in the main process: `electron-updater` dependency, an update feature wired in the composition root (packaged only), state pushed to the renderer over a typed IPC contract, and a "restart and install" request.
- [ ] U3 Renderer notice: "update ready" notice with a restart action, en/es strings, unit tests.
  - Scope change 2026-11-10 (reason: user asked for a Notion-style update toast): a small card fixed bottom-left of the main window above the sidebar footer, non-blocking, existing card/toast tokens. Top row: update icon, bold "A new version of Vozella is available!" plus "(<current> → <new>)", close (×). Body: "Would you like to install it now? Vozella will restart." Actions: "Remind me later" (text) and "Install now" (outlined, calls quitAndInstall through `updates.install`). Shown when the download is ready; "Remind me later" and × hide it until a few hours later or the next launch (it still installs on quit). Hidden while a recording is in progress, shown again when it stops. Main sends both versions. en/es strings; role status / aria-live polite, focusable buttons, Esc dismisses.

## Checks
`pnpm check` (typecheck, lint, unit tests) in the worktree; `pnpm package` produces `latest.yml` naming the versioned installer; workflow YAML reviewed (CI cannot run locally).

## Delivery
Strategy: merge to main (solo project, no PRs). Forecast about 400 to 500 authored lines.

## Progress
- 2026-11-10: worktree created from main `1d3eb94`, apart from the in-progress BYOK work in `C:\Code\vozella`. Route: delegated writer (2+ non-trivial files across contracts, main, renderer, workflow).
