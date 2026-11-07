# Feature: Action item deadlines (phase 1)

Locator: `odd/tasks/action-item-deadlines.md` · Engram mirror: `odd/action-item-deadlines/tasks` · Branch: `feat/action-item-deadlines`

## Objective
Turn the deadlines spoken in a meeting ("for next class bring the progress on X") into dated action items that the user confirms and exports to their own calendar as an `.ics` file. No OAuth in this phase.

## Problem / why
Action items are `{ text, isDone }` only. Competitor research (2026-11-06) found due dates are the weakest field across meeting note-takers; nobody documents resolving relative deadlines like "next class", and wrong invented dates destroy trust. Our angle: every date carries the quote that justifies it, code (not the model) computes it, the user confirms, nothing leaves the machine without a click.

## Scope (authorized: phase 1)
- Model output per action item: optional owner, optional deadline quote (exact transcript words) and a deadline kind token. Never invent a date.
- Deterministic resolver: kind + meeting `recordedAt` → date; `next_meeting` stays unresolved and asks "When is the next session?", remembered per meeting title.
- Persist owner/deadline per item in the meeting Markdown, backward compatible with existing files.
- Summary tab: confirmation queue: each item with deadline shows quote + editable date; user selects items and exports.
- `.ics` export (all-day `VEVENT`, Google Calendar ignores `VTODO`) through a save dialog.

Out of scope: Google/Microsoft OAuth, reading calendars, Google Tasks / Microsoft To Do (phase 2).

## Constraints
- One shared prompt for all engines (`packages/core/src/summaries/prompt-builders.ts`); prompt tests and `docs/port/specs/summaries.md` must agree.
- Meeting storage is Markdown; old files must still load. `recordedAt` has a numeric offset only (no IANA zone).
- Test first (RED→GREEN), en + es keys for all UI text, `pnpm check` before each commit.
- Delivery strategy: ask-on-risk (forecast ~1000–1300 authored lines > 400).

## Tasks
- [x] T1 Domain: extend `ActionItem` with `owner?`, `deadline?` (`quote`, `kind`, `date?`); parse the model line format; persist in meeting Markdown with round-trip + legacy compatibility. Route: delegated (writer trigger: 3+ non-trivial files).
- [x] T2 Deadline resolver (pure): kinds `date:YYYY-MM-DD`, `weekday:<mon..sun>`, `in_days:<n>`, `next_week`, `next_meeting`, `none` → date relative to `recordedAt`. Route: delegated with T1 or inline.
- [ ] T3 Prompt: ask for `— Owner: … — Due: <kind> "<exact quote>"`; update prompt tests + spec doc. Route: delegated.
- [ ] T4 Contracts + core service: set/clear item date, remember next-session date per meeting title, build `.ics` text, `summaries.exportIcs` IPC with save dialog. Route: delegated.
- [ ] T5 Renderer: confirmation queue UI in the summary tab, date editing, export button, en/es i18n, a11y. Route: delegated.
- [ ] T6 e2e: Playwright spec for review + export with stubbed dialog. Route: delegated.

## Acceptance criteria
- An action item with "para la siguiente clase" shows the quote, no invented date, and asks for the next session date; after answering, the date fills in and is remembered for the same meeting title.
- "el viernes" in a meeting recorded on a Wednesday resolves to that Friday.
- Exported `.ics` imports into Google Calendar / Outlook as all-day events with the item text and the meeting title.
- Existing meeting files load unchanged; items without deadlines behave as before.

## Checks
`pnpm --filter <pkg> test`, `pnpm typecheck`, `pnpm lint`, `pnpm check` per task; `pnpm test:e2e` for T6.

## Progress
- 2026-11-06: exploration done (pipeline map), branch created. RDD: off (global).

## Next step
T1 + T2.
