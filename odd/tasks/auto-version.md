# Feature: Automatic semantic version from commits

Locator: `odd/tasks/auto-version.md` · Engram mirror: `odd/auto-version/tasks` · Branch: `feat/auto-version`

## Objective
The release version computes itself from Conventional Commits, and a dev build's "About" shows the real version instead of a stale `0.9.0`.

## Problem
- `.github/workflows/release.yml` publishes a release on every push to main. Version = `apps/desktop/package.json` major.minor + patch `GITHUB_RUN_NUMBER - 2` (tags v0.9.1..v0.9.7). The minor never moves unless edited by hand, and a cancelled run burns a patch number.
- Dev builds read `apps/desktop/package.json` (`0.9.0`) through `apps/desktop/src/main/bootstrap/app-version.ts`, so "About" shows 0.9.0 while 0.9.7 is released.

## Approved approach (user approved 2026-11-07)
- V1 Next version from the last `v*` tag and the commits since it: any `feat` → minor + 1, patch 0; breaking (`!` or `BREAKING CHANGE`) → minor + 1 while major is 0 (major + 1 from 1.x); otherwise patch + 1. No tag → package.json version. A small dependency-free Node script with unit tests; release.yml uses it instead of the run number. Expected next release from main: 0.10.0.
- V2 Dev "About" shows `<last tag version>+<commits since> (<short sha>, dev)`; packaged builds unchanged (the version CI wrote).

## Tasks
- [x] V1 Version script + tests + release.yml. Route: delegated writer. Commit `3aea861`. `scripts/next-version.mjs` (pure `nextVersion`/`bumpLevel`/`parseVersion` + git CLI); tests use `node --test` (no vitest at the workspace root), wired into the root `pnpm test`. release.yml uses the script and fails early if `v<version>` is already tagged (no commits since the last tag). `apps/desktop/package.json` set to the last released `0.9.7`.
- [x] V2 Dev version in About. Route: same delegated writer. Commit `5f85e87`. `src/main/bootstrap/dev-version.ts` parses `git describe --tags --long`; `electron.vite.config.ts` defines `__VOZELLA_DEV_VERSION__` for main; `index.ts` uses it only when `!app.isPackaged`.

## Checks
Script unit tests; desktop typecheck/lint/prettier; focused tests around app-version; workflow YAML reviewed (cannot run CI locally; dry-run the script against the real repo history).

## Progress
- 2026-11-07: found the existing CD versioning; approach approved; branch created from main `b64ffb3`.

- 2026-11-07: V1+V2 done. Observed checks:
  - `node --test "scripts/*.test.mjs"`: 14/14 pass (RED first: module missing).
  - `node scripts/next-version.mjs`: `0.10.0`.
  - `vitest run src/main/bootstrap/dev-version.test.ts app-version.test.ts`: 9/9 pass (RED first).
  - `pnpm --filter @vozella/desktop typecheck`: pass. eslint (touched files, `--no-ignore` for scripts/): clean. prettier --check touched files: clean, except release.yml which already failed prettier on main (not in the lint glob).
  - `pnpm build`: pass; `out/main/index.js` holds `"0.9.7+51 (3aea861, dev)"`.
  - release.yml parses with js-yaml (10 steps); step logic simulated in pwsh locally. CI itself not run.
  - No e2e spec reads the version or About.

## Next step
Merge `feat/auto-version` into main; the first release from it should be v0.10.0.
