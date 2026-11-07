# Feature: AI panel resizable in a non-maximized window

Locator: `odd/tasks/ai-panel-resize.md` · Engram mirror: `odd/ai-panel-resize/tasks` · Branch: `fix/ai-panel-resize`

## Objective
The AI chat panel can be resized at any window size, not only when maximized.

## Problem
- Docked, the handle's max is `available - DOCK_MIN_CONTENT_WIDTH (560)` clamped to 320..520 (`apps/desktop/src/renderer/features/chat/AiPanel.tsx:161`), so in a ~900 px window the range is ~320..340 and the handle barely moves.
- Overlay mode (page would drop under 560 px) collapses the `Splitter` (`collapsed={!docked}`, `AiPanel.tsx:245`), so there is no handle at all.

## Approved approach (user approved 2026-11-07)
- R1 Lower `DOCK_MIN_CONTENT_WIDTH` from 560 to 400 so the docked handle has real range in medium windows.
- R2 Add a resize handle on the left edge of the floating (overlay) panel: drag, keyboard (arrows, Home/End) and double-click reset like the docked `Splitter`; width clamped to `PANEL_MIN_WIDTH`..min(`PANEL_MAX_WIDTH`, available); persisted to the same `vozella.aiPanel.width` key.

## Tasks
- [x] R1 Lower the dock minimum, with unit tests for `panelMode` and the docked max. Route: delegated writer (2+ non-trivial files). Commit `5bda3b5`. Added `dockMaxWidth` / `overlayMaxWidth` in `ai-panel-layout.ts` (RED: 5 failing tests, then GREEN). Existing overlay tests moved from 800/900 px to 700 px, since those widths now dock.
- [x] R2 Overlay resize handle, with unit tests and an e2e check at a narrow window. Route: delegated writer. Commit `46236c9`. `SplitterHandle` extracted from `Splitter` (which also takes a controlled `size` now); the floating panel renders it inside its `<aside>`, so a drag never counts as a click outside. Shrinking the floating panel until it fits docks it, and focus moves to the docked handle. RED: 4 failing `AiPanel` tests, then GREEN.

## Checks
Focused vitest for the chat feature and `ui/splitter*`; `pnpm --filter @vozella/desktop typecheck` + lint; affected e2e specs (AI panel / record-idle).

## Progress
- 2026-11-07: cause found, approach approved, branch created.
- 2026-11-07: R1 and R2 done. Observed checks: focused vitest (chat + `ui/Splitter*` + `splitter-logic*`) 13 files / 171 tests passed; `pnpm --filter @vozella/desktop typecheck` passed; eslint on touched paths passed; prettier --check passed; after `pnpm build`, `e2e/chat-panel.spec.ts` 8 passed / 1 skipped (screenshots), `e2e/record-idle.spec.ts` 8 passed.

## Next step
Review the two commits, try the floating panel by hand in a narrow window, then merge into main.
