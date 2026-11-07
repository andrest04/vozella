# Feature: Chat empty state as a vertical starter list with inline edit

Locator: `odd/tasks/chat-starter-list.md` · Engram mirror: `odd/chat-starter-list/tasks` · Branch: `feat/chat-starter-list`

## Objective
Replace the wrapping starter chips in the empty AI chat with a vertical list under a contextual heading, with a pencil to edit saved prompts inline (pattern from Notion AI's "Meeting note skills", user approved 2026-11-07).

## Why
In a narrow panel the chips wrap into two uneven rows and truncate. A vertical list reads better at any width, and editing a saved prompt today takes opening the book flyout.

## Scope
- `StarterChips` (rendered by `ChatBody.tsx:135` when the conversation is empty) becomes a vertical list: one row per starter (icon + name), full width, click sends at once as today (`sendWith(recipe.prompt, recipe)`).
- A small heading above it, contextual to scope/context (e.g. meeting with action items vs. content like a class/talk; other scopes a generic heading). Strings via the existing i18n (en + es).
- Saved prompts in the list show a pencil on hover/focus that opens the existing prompt editor (`library.actions.onEdit`). Built-ins have no pencil.
- Out of scope: the floating launcher showing a suggested action.

## Tasks
- [x] S1 Vertical starter list + contextual heading + pencil for saved prompts, with component tests, i18n en/es, and updated e2e. Route: delegated writer (2+ non-trivial files). Commit `6b05c43`.
- [x] S2 (added by coordinator) Empty composer keeps a long placeholder on one line (ellipsis) with no scrollbar; scrolls only past 96 px. Route: same delegated writer. Commits `99ceefc` (fix + unit tests), `5033c81` (e2e proof).

## Checks
Focused vitest for `features/chat`; desktop typecheck + eslint on touched paths; prettier; affected chat e2e specs.

## Progress
- 2026-11-07: approved; branch created from main `5033ab8`.

- 2026-11-07: S1 done. `StarterChips` replaced by `StarterList` (`ul`/`li`, row button `BtnChatStarter`, pencil `BtnChatStarterEdit` labelled "Edit <name>" via existing `Ui_ChatPromptEdit`); heading from `starter-heading.ts`; new keys `Ui_ChatStarters{Meeting,Recording,Folder,Library,Live}` in `ui.en.json`/`ui.es.json`. RED observed (18 failing) before GREEN.
- 2026-11-07: S2 done. `composer-fit.ts` sizes the box (empty draft = 32 px, overflow-y auto only past 96 px); placeholder `truncate`. New e2e failed on the pre-fix build (scrollbar shown) and passes after.

## Verification evidence
- vitest `src/renderer/features/chat`: 13 files, 181 tests passed.
- `pnpm --filter @vozella/desktop typecheck`: exit 0.
- eslint on touched `.ts/.tsx`: clean. prettier --check on touched files: clean.
- `pnpm build`: ok. Playwright: chat-panel, chat-conversation, chat-recipes, chat-saved-prompts, live-questions: 22 passed, 1 skipped; chat-layout: 4 passed.

## Next step
Parent review, then merge to main.
