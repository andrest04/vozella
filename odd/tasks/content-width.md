# Feature: Wider page content on Settings, Record and the meeting page

Locator: `odd/tasks/content-width.md` · Engram mirror: `odd/content-width/tasks` · Branch: `feat/content-width` (worktree `C:\Code\vozella-worktrees\content-width`, parallel to `feat/chat-starter-list`)

## Objective
Remove the large empty side margins on wide windows (user report 2026-11-07, 1920 px screenshots: content was ~640–810 px wide and centered).

## Approved approach (user approved 2026-11-07)
- Settings and Record: content fills the width up to a high cap of about 1100–1200 px.
- Meeting page (SessionRoute): header, actions toolbar and tabs fill the width (same high cap); reading text (summary Markdown, transcript, notes) keeps a comfortable measure of about 900 px, left-aligned, not centered.
- Keep the current padding/behaviour at small widths.

## Tasks
- [x] W1 Settings + Record + meeting page widths, with updated unit/e2e/screenshot expectations. Route: delegated writer (2+ non-trivial files). Commit `c8cb24b`.
  - Tokens in `styles/index.css`: `--container-page: 1152px` (content), `--container-reading: 900px` (`max-w-reading`). Root font size is 14px, so the cap adds the padding in spacing units: `ui/page.ts` `pageColumn` = `mx-auto w-full max-w-[calc(var(--container-page)+var(--spacing)*20)] px-10 pt-8`.
  - Choice: the column is centered with the cap (balanced on 1920 px: ~228 px each side next to a 1152 px content column); below the cap it is full width with the old padding. `AppShell.contentColumn(pathname)` picks the page column for every route except `/library` (panes). Edit surface widened by the coordinator to `features/shell/AppShell.tsx` and `AppShell.test.tsx`.
  - Record: dropped the 640 px column (RecordRoute) and the 960 px cap (RecordIdle). Meeting page: section uncapped; summary article, notes editor and transcript region get `max-w-reading`, left-aligned. Settings: inherits the column; `SettingRow` descriptions stay at `max-w-prose` with the control right-aligned.

## Checks
Focused vitest for touched features; desktop typecheck; eslint/prettier on touched files; affected e2e specs (settings, record-idle, session/summary specs).

## Progress
- 2026-11-07: approved; worktree branch created from main `5033ab8`.

- 2026-11-07: W1 done (`c8cb24b`). Test-first: RED observed for 11 new/updated unit tests, then GREEN.

## Verification (W1)
- `vitest run` record/session/settings/summaries/shell/ui/styles: 47 files, 705 tests passed.
- `pnpm --filter @vozella/desktop typecheck`: pass.
- `eslint` on touched TS/TSX: pass. `prettier --check`: pass except `styles/index.css`, whose only difference is CRLF in the autocrlf working copy (the blob is LF).
- `pnpm build`: pass.
- e2e (`content-width`, `settings-ui`, `settings-screens`, `record-idle`, `session-shell`, `session-transcript`, `summaries-view`, `shell-chrome`): 49 passed, 11 skipped (screenshot opt-in), 1 failed: `record-idle` "after a take the row stays in view..." resizes to 1198 instead of 1196 (display-scale rounding). It fails the same way on the base build without this change: pre-existing, not caused by W1.
- New `e2e/content-width.spec.ts`: 1920 px window gives a 1152 px centered content column on Settings, Record and the meeting page, summary and transcript at most 900 px, left-aligned; 960 px window is full width with the same padding and no horizontal scroll. Screenshots reviewed visually.

## Next step
Parent review; merge `feat/content-width` to main when accepted.
