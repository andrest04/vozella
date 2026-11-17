# Flat projects

Design for replacing nested Library folders with flat, Claude-style Projects in Vozella. Branch `feat/projects`. Status: design, ready for the Contracts phase.

How to read this: sections 1 to 3 say what and why, 4 to 7 say how it is stored and wired, 8 is the UI, 9 to 12 are removals, tests, risks and decisions, 13 is the implementation plan (Contracts phase, five parallel lanes, merge order, e2e).

## 1. Goals

- A project is a flat container for related meetings, with instructions and context files that the assistant uses everywhere it speaks: the Live copilot, chat and summaries.
- The Projects tab is a grid of project cards. A project page has a primary action, "Start meeting in this project", a Meetings tab, a Chats tab, and a right panel with Instructions and Context files.
- Meetings with no project stay first-class: a "No project" list with "Move to project".
- Chat history is persisted per project (and for no project): listable, reopenable, deletable.
- Existing libraries migrate once, automatically, without moving a single meeting file, with a backup, and idempotently. Every old folder, including subfolders, becomes its own project and keeps its id.
- Storage is versioned with forward migrations so the next change is a new migration, not a rewrite. One module per feature, core stays pure, platform implements ports, contracts hold the zod schemas.
- No .NET or WinUI compatibility in the new storage.

## 2. Non-goals

- Memory, Scheduled, project sharing, archiving, nested projects, tags, project templates.
- Image files in a project (v1 supports PDF, DOCX, PPTX, TXT, MD, CSV, the same extractors as chat attachments, minus images).
- Drag and drop of files onto the project panel (the picker is v1; drop reuses the preload bridge later).
- Embeddings or a database. Retrieval stays BM25 in memory (stack.md: no database until a measured need).
- Renaming the Jev analysis field `suggestedFolderId` and the remaining WinUI traces outside library storage (meeting Markdown CRLF and .NET escaping, Whisper cache cleanup): separate follow-up purge, listed in section 10.
- Cloud sync, cloud AI. Context never leaves the PC except to the engine the user already chose for that send, as today.

## 3. Domain model

Names are final; core types live in `packages/core/src/projects` and `packages/core/src/chat/chat-thread.ts`, zod mirrors in `packages/contracts`.

```ts
interface Project {
  readonly id: string;            // lowercase GUID; migrated projects keep the folder id
  readonly name: string;          // 1..120 chars, unique by folded text (case and accent insensitive)
  readonly description: string;   // 0..500, shown on the card and the page header
  readonly instructions: string;  // 0..20_000, the former folder note for migrated projects
  readonly pinned: boolean;
  readonly colorKey: string | null; // user-chosen accent, kept from folders
  readonly iconKey: string | null;
  readonly createdAt: string;     // ISO-8601 UTC ("2026-11-16T14:03:00.000Z")
  readonly updatedAt: string;     // metadata edits only (name, description, instructions, pin)
}

interface ProjectFile {           // owned by the project, copied into project storage
  readonly id: string;
  readonly name: string;          // original file name
  readonly kind: 'pdf' | 'docx' | 'pptx' | 'text';
  readonly sizeBytes: number;
  readonly pages: number | null;
  readonly truncated: boolean;    // extracted text cut at ATTACHMENT_MAX_CHARS (200_000)
  readonly textChars: number;
  readonly sha256: string;        // duplicate detection
  readonly addedAt: string;
}

interface ChatThread {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ownerProjectId: string | null;  // null is "no project"
  readonly scope: { kind: 'AllMeetings' | 'Project' | 'Meeting' | 'Live'; meetingId: string | null };
  readonly title: string;                   // first user message, one line, 60 chars; renamable
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
}
interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }
```

Rules:

- A meeting belongs to at most one project. In memory the field is `projectId` (renamed from `folderId` in the Contracts phase). On disk the Markdown frontmatter key stays `folderId`: the two-line mapping (parse and render) lives only in `meeting-markdown.ts`, which is what keeps every meeting file and every `https://meetinglive.local/meeting/<id>` link valid. A meeting whose project id is unknown (deleted, or never existed) reads as "no project", exactly as the Inbox rule does today.
- "No project" is the former Inbox: `projectId === null` or an unknown id. Its directory stays `<Library>/Inbox`.
- Thread owner is resolved when the thread is created: scope Project uses that project, Meeting uses the meeting's project, Live uses the take's project, AllMeetings is no project. A thread stays with its owner even if the meeting moves later. This is what makes "Chats of a project" include its meeting chats.
- Chat attachments stay per conversation and are not persisted; a message stores only the attachment names for display.
- Project files are not meetings: they are never indexed, searched as meetings, or shown in the Library.

## 4. Storage

### 4.1 Layout on disk

```text
<Library>/                              default Documents\Vozella; location is user-selectable (unchanged)
  Inbox/                                meetings with no project: *.md + *.wav (unchanged)
  <project dir>/                        meetings of one project: *.md + *.wav (+ mic activity files)
  .vozella/                             ours; dot-directories are never scanned for meetings
    library.json                        manifest: schemaVersion, migration log, pending notice
    backups/
      folders.v0.<UTC timestamp>.json   byte-for-byte copy of the old folders.json
    projects/
      <projectId>/
        project.json                    Project + dir (+ origin for migrated projects)
        files/<fileId>/
          original.<ext>                the copy
          extracted.json                sections with page/slide locations, pages, truncated
          meta.json                     ProjectFile; written LAST, so no meta.json = aborted add
        chats/<threadId>.json           ChatThread
    no-project/
      chats/<threadId>.json             threads whose owner is no project
```

Why meetings stay outside `.vozella`: they are the user's files, usable in any editor (PRODUCT.md "Meetings are files"). Why project data is inside the Library and not in app data: it travels with the meetings when the user moves or backs up the Library, which the old `folders.json` already did and `chat-threads.json` never did.

### 4.2 Formats and versioning

Plain UTF-8 JSON, LF, two-space indent, no BOM, camelCase keys, ISO-8601 UTC dates, written with `writeFileAtomic` (temp file, rename) under a per-path keyed mutex. No CRLF, no .NET escaping, no case-insensitive key reading in the new readers.

```json
// <Library>/.vozella/library.json
{
  "schemaVersion": 1,
  "createdAt": "2026-11-16T14:03:00.000Z",
  "migrations": [
    { "id": "001-folders-to-projects", "appliedAt": "2026-11-16T14:03:01.120Z",
      "report": { "projects": 7, "renamed": [{ "id": "…", "from": "Cálculo", "to": "Universidad – Cálculo" }], "backup": "backups/folders.v0.20261116T140300Z.json" } }
  ],
  "pendingNotice": { "kind": "folders-to-projects", "projects": 7, "renamed": 2 }
}

// <Library>/.vozella/projects/<id>/project.json
{
  "schemaVersion": 1,
  "id": "9f1c…", "name": "Universidad – Cálculo", "description": "", "instructions": "Resumir en español…",
  "pinned": false, "colorKey": "blue", "iconKey": null,
  "dir": "Universidad/Cálculo",
  "createdAt": "2025-03-02T15:00:00.000Z", "updatedAt": "2025-03-02T15:00:00.000Z",
  "origin": { "kind": "folder", "parentId": "1b7e…", "originalName": "Cálculo" }
}
```

Two levels of version, one rule each:

| Change | Mechanism | Cost |
| --- | --- | --- |
| Layout (files move, directories change, a new top-level file) | Bump `STORAGE_SCHEMA_VERSION` in the manifest; add one entry to the ordered `MIGRATIONS` registry; runs eagerly at startup | Once per library |
| Fields of one file kind | Bump that kind's `schemaVersion` literal; add the new version to its zod union and an `upgrade` function; readers upgrade in memory, writers always write the latest | None at startup |

A manifest newer than the app (`schemaVersion > STORAGE_SCHEMA_VERSION`) throws `StorageTooNewError`: the app writes nothing under `.vozella`, projects report failure `storage-newer`, and meetings keep working. A corrupt project, file or thread JSON is skipped and reported (like unreadable meetings), never deleted and never blocks the rest.

The directory of a project, `dir`, is chosen when the project is created and then frozen. Renaming a project changes only the name. This removes the old directory move plus the rewrite of every `audioFilePath` (the `rewriteSiblingAudioPaths` logic) and the reserved-name rules (`Meetings`/`Recordings`). Trade-off: after a rename the folder in Explorer keeps the old name. New projects get a one-segment directory from the sanitized name, de-duplicated with " 2", " 3", never `Inbox` and never starting with a dot. Moving a meeting between projects still moves its `.md`, `.wav` and mic activity file through `MarkdownMeetingRepository.save` (existing behavior, now one level).

### 4.3 Migration: folders.json to projects (storage version 0 to 1)

Version 0 means "no manifest". The runner (`migrateStorage`, platform) reads the manifest, refuses a newer one, then applies every migration whose `to` is greater than the current version, in order. After each successful step it atomically writes the manifest with the new `schemaVersion` and a log entry. A throwing step stops the run, is logged, becomes the startup error the window already shows (StartupNotice), and leaves the manifest as it was, so the next launch retries. This replaces the three legacy steps of `runStartupMigrations`.

Step `001-folders-to-projects`:

1. Read `<Library>/folders.json` with the legacy reader (the only code that still knows that format: strips a BOM, accepts any key case). Missing file means an empty list (fresh install or never had folders). Unreadable or invalid: stop, write no manifest, surface the error; meetings keep listing as "no project".
2. Back up first: copy to `.vozella/backups/folders.v0.<UTC>.json` (never overwrites, counter on clash), verify the byte length, and only then continue. Nothing else is written before this succeeds.
3. Compute names (pure function `resolveMigratedNames` in core). Order folders by depth, then `createdAt`, then id, so results are deterministic.
   - A name that is unique across all folders (compared with `foldText`: case and accent insensitive, trimmed) is kept as is.
   - For colliding names, every colliding folder that has a parent is renamed `<parent name> – <name>` (en dash with spaces) using the parent's original name: `Cálculo` under `Universidad` becomes `Universidad – Cálculo`.
   - If that still collides (two parents with the same name, or a root already called `Universidad – Cálculo`), use the whole ancestor chain joined with ` – `.
   - If it still collides, append " 2", " 3" in the same deterministic order.
   - Root folders always keep their name; if a renamed result collides with one, the renamed folder gets the numeric suffix. A folder whose parent no longer exists is a root (the old B26b rule, applied once here and never again).
4. Directory: `dir` is the old chain path under the Library root, computed by a frozen copy of the old segment rule inside the migration module (sanitized names, the ` folder` suffix for `Inbox`/`Meetings`/`Recordings`). Because the files stay where they are, no meeting, recording or audio path is touched and the step cannot orphan data. Projects of a parent and a child end up as two independent projects whose directories happen to be nested on disk; nothing in the code treats that as a relationship (the scanner already walks every depth).
5. Write `projects/<id>/project.json` for every folder: id kept, `instructions = note ?? ""`, `description = ""`, `colorKey`/`iconKey` kept, `createdAt` converted from the offset date to the same instant in UTC, `updatedAt = createdAt`, `origin` recorded. Each write is atomic and idempotent (same input, same bytes), so a crash after N projects is resumed by rerunning the step.
6. Write the manifest (version 1, log entry with the report, `pendingNotice`). Then delete `folders.json` (best effort: if it cannot be deleted the manifest still governs and the next launch skips the step).
7. The UI shows the notice once ("7 folders became projects. 2 were renamed to avoid duplicates.") with the renamed list in the Projects page; dismissing clears `pendingNotice`.

Idempotency: version 1 in the manifest skips the step. Rerunning a half-finished step recomputes the same names and overwrites the same files. The backup is created once per attempt that reaches step 2 and is never deleted by the app.

Fresh installs run the same code with an empty folder list: manifest v1, no backup, no notice.

### 4.4 Directory mirror decision

The tree on disk stops being a mirror of a hierarchy. It becomes "one directory per project, plus Inbox", with the directory name frozen in `project.json`. Meetings are found by scanning, as today, and their project is the frontmatter id, so the mirror is cosmetic. Dot-directories are skipped by the scanner. The legacy flat-dump handling (`Library/Meetings`, `Library/Recordings`, `isLegacyFlatDump`, `locate`, the `legacy` flag in `prefer`) is deleted: a duplicate id is resolved by newest modified time.

## 5. Ports and adapters

Dependency direction as in stack.md: `apps/desktop → platform → core`, `contracts` shared. Each port has one adapter and one in-memory fake in core (used by every lane's tests).

```ts
// packages/core/src/projects/ports.ts
interface ProjectRepository {                 // adapter: FileProjectRepository (platform/projects)
  list(): Promise<{ projects: Project[]; skipped: SkippedProject[] }>;
  get(id: string): Promise<Project | null>;
  create(input: NewProject): Promise<Project>;            // allocates id and the frozen dir
  update(id: string, patch: ProjectPatch): Promise<Project | null>;
  delete(id: string): Promise<void>;                      // discard() of .vozella/projects/<id>; the caller moved the meetings
  directoryOf(id: string | null): Promise<string>;        // absolute; null or unknown = <Library>/Inbox
}
interface ProjectFileStore {                  // adapter: createProjectFileStore (platform/projects)
  list(projectId: string): Promise<ProjectFile[]>;
  countByProject(): Promise<ReadonlyMap<string, number>>;
  add(projectId: string, sourcePath: string): Promise<AddProjectFileResult>;  // validate, hash, extract, copy
  remove(projectId: string, fileId: string): Promise<boolean>;
  readDocuments(projectId: string): Promise<readonly AttachedDocument[]>;     // extracted text for context
}
interface ProjectContextSource {              // adapter: createProjectContextSource
  get(projectId: string): Promise<{ projectId: string; name: string; instructions: string;
                                    documents: readonly AttachedDocument[] } | null>;
}
// packages/core/src/chat/chat-thread.ts
interface ChatThreadRepository {              // adapter: createChatThreadStore (platform/chat)
  list(owner: string | null): Promise<ChatThreadSummary[]>;      // newest first
  get(owner: string | null, id: string): Promise<ChatThread | null>;
  save(thread: ChatThread): Promise<void>;
  rename(owner: string | null, id: string, title: string): Promise<boolean>;
  delete(owner: string | null, id: string): Promise<boolean>;
  activity(): Promise<ReadonlyMap<string | null, string>>;       // last updatedAt per owner, for cards
}
```

- `MarkdownMeetingRepository` receives `Pick<ProjectRepository, 'directoryOf'>` instead of the folder repository. It keeps its index, folded-text cache and batch semantics.
- `ProjectService` (core) holds the use cases: create, update (name uniqueness by folded text), setInstructions, pin, list (computes `meetingCount`, `fileCount` and `lastActivityAt = max(project.updatedAt, newest meeting recordedAt, chat activity)`), delete. Delete refuses while a meeting of the project is busy, moves every meeting to no project in one `MeetingRepository.batch`, aborts without deleting anything if one move fails, and only then discards the project directory (Recycle Bin through the injected `discard`, recoverable). Instructions, files and chats of a deleted project go with it.
- `LibraryRuntime` keeps owning "where the library lives" and rebuilds every service when the location changes; it builds the project repository, service, file store, thread store and context source and runs `migrateStorage`. Other composition roots read them through `liveRepository(() => library.x)`, so a location change never leaves a stale handle.
- Main-process controllers are thin: they validate with zod (done by `registerRequest`), call the service, broadcast `projects.changed` / `library.changed`.
- Patterns, each with a forcing problem: Hexagonal ports because storage and extraction vary (fs now, something else later) and core must stay pure; a registry of ordered migrations because layout changes will recur and must not be one growing function. No factories beyond the four `create…` functions that the composition root needs.

## 6. IPC contracts

Zod schemas in `packages/contracts/src/projects.ts` and `chat.ts`; same `defineRequest`/`defineEvent` style as today. Every answer is a value, never a thrown error.

| Channel | Input | Output |
| --- | --- | --- |
| `projects.list` | {} | ok: `projects: ProjectListItem[]`, `noProject: {meetingCount, lastActivityAt}`, `skipped` / failure |
| `projects.get` | {id} | ok: `project: Project + files: ProjectFile[]` / failure |
| `projects.create` | {name, description?} | ok: project / failure `empty-name, name-taken, too-long, storage-newer, io-failed` |
| `projects.update` | {id, name?, description?, pinned?, colorKey?, iconKey?} | ok: project / failure |
| `projects.setInstructions` | {id, instructions} (max 20_000) | ok: project / failure |
| `projects.delete` | {id} | done / failure `busy, io-failed, trash-failed, not-found` |
| `projects.files.pick` | {projectId} | opens the picker in main; `results: AddProjectFileResult[]`, or empty on cancel |
| `projects.files.add` | {projectId, paths[]} (max 10) | `results[]`; paths re-validated in main |
| `projects.files.remove` | {projectId, fileId} | `{removed}` |
| `projects.migrationReport` / `projects.dismissMigrationReport` | {} | report or null / {} |
| `projects.changed` (event) | | {reason: 'project' or 'files', projectId or null} |
| `library.load` | {} | meetings and skipped only (no folders) |
| `library.moveMeeting`, `library.moveMeetings` | {…, projectId: string or null} | as today |
| `library.search` | {query, scope: all or none or project(id), requestId} | as today |
| `library.changed` (event) | | reason: meeting, project, location |
| `chat.threads.list` | {projectId: string or null} | {threads: ChatThreadSummary[]} |
| `chat.threads.open` | {projectId, id} | `chat.state` plus the thread's scope (refused while sending) |
| `chat.threads.rename` / `chat.threads.delete` | {projectId, id, title?} | {ok} |
| `chat.threads.changed` (event) | | {projectId} |
| `chat.state` | | adds `threadId: string or null` |
| `chat.setScope` | scope with `kind: Project`, `projectId` | as today |
| `recording.start`, `recording.importUrl`, import | `projectId` replaces `folderId` | as today |
| workspace action | `publishSelectedProject` | |

Removed: `library.createFolder`, `renameFolder`, `updateFolderPersonality`, `setFolderNote`, `deleteFolder`, `folderSchema`, every `parentId`.

Security: the page never sees file system paths of project storage; file picking and path validation stay in main (same rule as chat attachments: absolute, local, regular file, no UNC or device paths, size and kind checked before reading). Project file text is untrusted data and is neutralized before it reaches a prompt (section 7).

## 7. Context assembly

One pure kernel in core, `packProjectContext`, builds the project block for every consumer. It is placed first in the context, labelled, and stays independent of the meeting blocks.

```text
Project: Universidad – Cálculo
Project instructions (follow them when answering; they come from the user):
<instructions, neutralized, capped>

Project files (excerpts when they do not all fit):
File: Syllabus.pdf (PDF, 12 pages; excerpts; other parts were left out)
[page 3]
…
```

- Instructions: capped with `cutPrefix`, structure-neutralized with the existing `neutralizeStructure` (forged `Id:` or `# ` lines).
- Files: `packAttachments(documents, filesChars, query)`, the existing BM25 packer (whole files when they fit, otherwise the best-ranked chunks in file order under page/slide tags, every file represented). Its file-text neutralization applies.
- Query by surface: chat = user text plus the last user turn; Live = the question asked; summary = meeting title, notes and the first 2000 characters of the transcript.

Budgets (characters, `projectBudgetFor(surface, providerId)`; remote means Claude Code, Codex or an API key engine; local means the bundled llama):

| Surface | Engine | Instructions | Files |
| --- | --- | --- | --- |
| Chat | remote | 8_000 | 24_000 |
| Chat | local | 800 | 1_000 |
| Live | remote | 3_000 | 6_000 |
| Live | local | 500 | 800 |
| Summary | remote | 6_000 | 12_000 |
| Summary | local | 1_500 (today's note cap) | 1_500 |

Local engine rule: the local model has 4096 tokens for prompt and answer (context-packer.ts). The size of the project block is subtracted from the meeting budget (`meetingChars`) in chat, and counted in the local prompt budget (`local-prompt-budget.ts`, `local-map-reduce.ts`) for summaries, so the total never grows and the answer keeps its room. Remote engines have the 120k character total; the project block is part of `context`, so `attachmentBudgetFor` already shrinks the chat attachments by the same amount (floor 24k).

Where each surface gets it:

| Surface | Today | New |
| --- | --- | --- |
| Live copilot (pill, dock, Live chat) | `packLiveSession` packs title, notes, digest; the Live scope ignores folders (`scope-resolver.ts` ~46) | `LiveAsk` knows the take's `projectId`; the block is resolved per question and passed as the third argument of `packLiveSession`, between the session lines and the digest. The local-model-never-loaded-mid-take rules are untouched |
| Chat, Project scope | Folder scope packs the folder note and meetings | The project block, then the project's meetings (newest, relevance-ranked, cap 12 as today) |
| Chat, Meeting scope | meeting only | project block of the meeting's project, then the meeting |
| Chat, All meetings | all | unchanged, no project block |
| Summary | `<folder_note>` and open items from related meetings | `<project_instructions>`, `<project_files>` and the same open items; any read failure leaves the context out and the summary runs (existing rule) |

Performance: `readDocuments` keeps an mtime-keyed in-memory cache; per project at most 25 files and 1_000_000 extracted characters, so one retrieval chunks and scores a bounded corpus. If a measured send exceeds roughly 150 ms, pre-chunk at add time into `extracted.json` (the format already has sections; a version 2 upgrade adds chunks), no database.

## 8. UI information architecture

Operate mode (impeccable): scanability and consistency over expression. Tokens only (paper, ink, hairline), radius 4 or 6, hairlines not shadows, `text-heading` for titles, sentence case, no exclamation marks, no emoji, no cards inside cards, errors in ink with icon and words, `signal` only for live recording. Strings in both locale files, UI lane only.

### 8.1 Sidebar

Rail: Record, Projects, Library, Settings. `/projects` and `/projects/<id>` keep Projects selected; Session keeps Library selected as today. Library becomes the flat "all meetings" list (search, filters, bulk, preview) with a project filter in place of the tree.

### 8.2 Projects grid (`/projects`)

```text
Projects                                              [ New project ]
[ Search projects      ]  Sort: Recent activity v
No project · 12 meetings                                          >
Pinned
┌──────────────────────┐ ┌──────────────────────┐
│ Universidad – Cálculo │ │ Producto Q4          │   card: name, 2-line description,
│ Resumir en español…   │ │                      │   "Updated 14 Nov", meetings count in mono,
│ 14 Nov · 9 meetings   │ │                      │   pin toggle (IconButton, label required)
└──────────────────────┘ └──────────────────────┘
All projects
…
```

(The pin is the Pin icon, shown on the card's top edge.) Sort: Recent activity (default), Name, Newest. Pinned projects form a first group when any exist. The accent (`colorKey`) is a 3 px muted bar on the card's start edge, never a fill. Cards are links: Tab order, Enter opens, a visible focus ring. Empty (no projects, no meetings): one line, "A project keeps related meetings, instructions and files together.", and the New project button. Search with no result: one line with the query and a clear action. Loading: skeleton cards of the real layout. The migration notice (section 4.3) sits above the grid until dismissed.

New project: dialog with Name (required) and Description (optional); inline errors for empty and name-taken (words plus icon, no red); Enter submits.

### 8.3 Project page (`/projects/<id>`)

```text
‹ Projects
Universidad – Cálculo                [ Start meeting in this project ]   [ … ]
Weekly lecture notes and exam prep                                    Rename · Edit description · Pin · Delete
 Meetings | Chats                                         │ Instructions                 [ Edit ]
 ───────────────────────────────────────────────          │ Resumir en español, con…
 search · filters                                         │
 2025-03-02  Clase 4 — Derivadas              52 min      │ Context files                [ Add ]
 2025-02-24  Clase 3 — Límites                48 min      │ Syllabus.pdf        PDF · 12 pages  x
 …                                                        │ notas.md            Text · 3 KB     x
```

- Header: name, description, one primary Button (`Start meeting in this project`, Mic icon), overflow Menu. "‹ Projects" is a plain back link, not a breadcrumb chain.
- Start meeting: navigates to `/record?project=<id>&start=1`; RecordRoute sets the destination and runs the same ensure-ready and start flow as the Record button (setup checklist, model gates, mic checks keep working). If the app is already recording, it opens the Record screen and does not start another take.
- Meetings tab: the existing meeting list scoped to the project, newest first, with search, filters, row selection, bulk bar (Move to project, Delete) and preview. Empty: "No meetings in this project yet." plus the primary action nearby.
- Chats tab: persisted threads of this owner, newest first: title, last activity, scope badge (Project, Meeting title, Live), row menu Rename and Delete. "New chat" opens the AiPanel with Project scope. Clicking a thread opens it in the AiPanel (`chat.threads.open`). Empty: "No chats yet. Ask about this project's meetings."
- Right panel (fixed 320 px at 960 px wide and above; below that the two sections stack under the header as disclosure sections):
  - Instructions: read-only excerpt (first 6 lines, then "Show all") and Edit. Edit opens a dialog with a textarea, a live character counter against 20_000 and Save/Cancel. Empty: "Tell Vozella how to summarize and answer for this project."
  - Context files: Add (picker), list of name, kind, size or pages, Remove (IconButton). Adding shows a row with a spinner and "Reading…", errors per row in words ("Encrypted PDF", "Duplicate", "Too large (max 20 MB)", "Limit of 25 files reached"). One quiet line: "Files are copied into this project and the relevant parts are used when you chat, ask live or summarize."
- Delete: confirm dialog naming the meeting count: "Delete project? Its 12 meetings move to No project. Instructions, files and chats of this project are deleted." The primary confirm is a normal Button (no danger variant in the kit).

### 8.4 No project (`/projects/none`)

Same frame without the right panel, title "No project", subtitle "Meetings that are not in a project". Meetings tab (rows have "Move to project" in the row menu; bulk bar has it too) and Chats tab (threads with no owner). Move to project opens a searchable flat list of projects (single-select, Enter confirms) plus "No project" when invoked from inside a project. After moving, an undo offer appears (existing UndoOffer). The same dialog is used from the Library list, the meeting preview and the session header.

### 8.5 Record destination

The destination select on Record lists "No project" first, then pinned projects, then the rest by name (flat, no "Parent / Child" paths). "Start meeting in this project" preselects it. The tray and popup entry points use the selected project (the page publishes it while open).

### 8.6 Chat panel

AiPanel header gets a History control: a popover list of threads for the current owner (project or no project), New chat, open, rename, delete. Opening a thread from anywhere sets the panel's scope to the thread's scope (pinned until the user navigates), and the existing scope-mismatch notice still explains when the page and the thread differ.

### 8.7 Copy rules

"Project", "No project" / "Sin proyecto", "Move to project" / "Mover a proyecto", "Instructions" / "Instrucciones", "Context files" / "Archivos de contexto". Existing values that say folder, carpeta or Inbox in the library sense are reworded; key names that core code references keep their names. Both locale files in the same commit, parity test green.

## 9. Test strategy

- Unit (Vitest, every package): pure logic first, RED before GREEN where a deterministic test exists: name resolution, project service, context packer, thread lifecycle, sort and search ordering, navigation helpers. The Contracts phase includes tests for the zod schemas and the shared kernel.
- Integration (Vitest with real fs): adapters run on `fs.mkdtemp` directories under the OS temp folder; the migration runs against a committed legacy fixture library (BOM, CRLF, nesting, collisions, orphans, 5 meetings); crash/resume by injecting a failing writer; backup byte equality; idempotency by running twice and comparing a directory snapshot. Every run sets `VOZELLA_DATA_ROOT` to a temp folder; the data-root guard refuses the real `Documents\MeetingLive` and `Documents\Vozella`. No real accounts, no model downloads.
- Contract: each new channel round-trips input and output through its zod schema; main handlers are tested with fakes.
- Component (jsdom): grid, page, dialogs, thread list, move dialog; keyboard behavior and accessible names.
- E2E (Playwright _electron, one spec `projects.spec.ts`, scenarios in section 13.5): run with `VOZELLA_E2E_BACKGROUND=1` so no window pops up. `pnpm check` (typecheck, lint, unit) passes before every commit.
- Not verifiable here: real Windows Recycle Bin behavior, real PDF files from the wild, long libraries (> 5k meetings) with many projects; recorded in the parity ledger as `pending-real-validation`.

## 10. Removal list

Nesting (all of it):

- core: `library/folder-tree.ts` (`folderChain`, `folderDirectorySegments`, `buildFolderTree`, `flattenFolderPaths`, `buildBreadcrumbs`, `expandedAncestors`; the locale collator moves next to the project sort), `FolderRecord.parentId`, `nameTaken` parent-scoped logic and the B26b orphan rule in `library-service.ts`, `canDeleteFolder` and the `not-empty` failure, `createFolder({parentId})`.
- renderer: `LibraryFolders.tsx`, `Breadcrumbs.tsx`, `ui/Tree.tsx`, `ui/tree-navigation.ts` and their tests and gallery entries, folder tree keyboard navigation, create-inside-current-folder, `expandedAncestors` in `library-store.ts`, `use-folder-note.ts` (instructions replace it), parent pickers in dialogs.
- contracts: `folderSchema`, `parentId`, the five folder channels.

WinUI and .NET compatibility in library storage:

- core: `folders-json.ts` (parse and serialize of the WinUI array, CRLF), the folder-only parts of `dotnet-json.ts` (the file itself stays while `meeting-markdown.ts` and `settings.ts` still use it), `RESERVED_FOLDER_NAMES` `meetings`/`recordings` and `folderDirectoryName` in `names.ts`, app-paths fields `meetingsFilePath`, `meetingsDirectory`, `recordingsDirectory`, `legacy*`, `foldersFilePath` (the migration derives its input path), `chatThreadsFilePath` (unused).
- platform: `json-folder-repository.ts` and its tests (directory mirror, `rewriteSiblingAudioPaths`), the three legacy migrations in `migrations.ts` (user data location, flat library layout, `meetings.json`) and `migrations.test.ts`, `winui-library.test.ts` and `fixtures/winui-library/`, in `markdown-meeting-repository.ts` the `isLegacyFlatDump` / `isUserFolderDirectory` / `locate` / `legacy` flag (B10, B12), `directoryFor` over folder chains in `library-layout.ts`.
- docs: the byte-compatibility bullet in `docs/port/stack.md` now applies only to meeting Markdown; `docs/port/specs/library-storage.md` folder sections are marked superseded.

Kept on purpose (AGENTS.md): `LEGACY_FOLDER_NAME = 'MeetingLive'`, `sharesMeetingLive`, the guard refusing real MeetingLive folders, the `https://meetinglive.local/meeting/` link scheme. Kept for now: meeting Markdown format and the Jev `suggestedFolderId` (stored data, follow-up purge together with the other 67 files that still mention WinUI).

## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Migration corrupts or loses folder data | High | Backup copy before any write; ids kept; no meeting file moved; folders.json deleted only after the manifest; idempotent and resumable; fixture tests including a crash; corrupt input blocks migration instead of guessing |
| A user opens the library with an older app after migrating | Medium | Backup stays in `.vozella/backups`; the older app finds no `folders.json` and shows everything as Inbox; documented in the notice. Forward-only by design |
| User points Vozella at an old MeetingLive library with generation 1 or 2 layouts | Medium | Those layouts are no longer migrated (legacy steps removed); folders.json of the current layout is still read by the migration. Recorded in the parity ledger as dropped |
| Newer library opened by an older Vozella | Medium | The manifest version check refuses to write and says to update |
| Prompt grows past the local model window | High for local users | Fixed small local budgets, project block carved out of the meeting budget, local prompt-budget tests |
| BM25 over large files is slow on every ask | Medium | Caps (25 files, 1M chars), mtime cache, pre-chunking as a v2 upgrade if measured; Live asks use small budgets |
| Prompt injection through project files or instructions | Medium | Existing neutralization of structural lines, labelled blocks, files presented as data, instructions as the user's guidance; same trust model as meeting text |
| Scanner picks up Markdown in project files | Medium | Project files live under `.vozella`, which the scanner skips; test with a `.md` context file |
| Large field rename (folderId to projectId, about 60 files) breaks lanes | Medium | Done once, mechanically, typecheck-driven, in the Contracts phase before lanes start; the on-disk key is unchanged |
| Frozen `dir` confuses users who look in Explorer | Low | Documented trade-off; new projects get readable names; revisit with a future "reveal folder" action |
| Deleting a project with chats loses history | Medium | Confirmation text states it; the project directory goes to the Recycle Bin |
| Concurrent writes (rename while adding a file) | Low | Per-project keyed mutex; every file written atomically; meta.json written last |
| Single UI lane is the largest | Medium | UI sections are independent (grid, page, no-project, chat history, record); the lane commits per section |

## 12. Decisions made in this design

These follow from the approved product decisions; flag any you disagree with before the Contracts phase.

1. The Library route stays as the flat all-meetings list (cross-project search, filters, bulk). Projects is a new rail entry; the folder tree is gone.
2. Project directories are frozen at creation; migrated projects keep their existing directories, so the migration moves no files.
3. The three WinUI-era startup migrations are removed together with the folder code.
4. `folderId` becomes `projectId` in code, IPC and domain; the frontmatter key is the only place that keeps the old name.
5. Threads are persisted for every chat scope and owned by a project or by no project; a thread is created on its first successful turn.
6. Dates in the new storage are ISO-8601 UTC; meeting frontmatter keeps its offset format.
7. Project files are copied, extracted once, never re-read from the original path, and images are out for v1.

## 13. Implementation plan

Phases: Contracts, then five lanes in parallel (each in its own worktree on a branch from the Contracts commit), integrate, multi-lens review with one fix round, e2e. Commits are conventional, tests and docs with behavior, no attribution, no push.

### 13.1 Contracts phase

CONTRACTS PHASE (serial, one writer, before any lane). Output must leave "pnpm check" green with the app still compiling; every lane file named below exists as a compile-clean stub or final code. Lanes may not touch anything this phase owns (see ownership list at the end).

1. Vocabulary rename (mechanical, typecheck-driven, includes tests): MeetingRecord.folderId and MeetingListItem.folderId become projectId (packages/core/src/library/meeting.ts and every user); ChatScopeKind 'Folder' becomes 'Project'; ChatScopeDecision/ThreadScope folderId becomes projectId; WorkspaceState.selectedFolderId becomes selectedProjectId and Workspace.publishSelectedFolder becomes publishSelectedProject; workspace action 'publishSelectedFolder' becomes 'publishSelectedProject'; recording start/import inputs folderId becomes projectId; ShellTag gains 'Projects' (SHELL_TAGS, tagOfPath, routeOfTag stay in the renderer lane). The persisted meeting frontmatter KEY stays "folderId" (meeting-markdown.ts maps key folderId <-> field projectId in exactly two places: parse ~382 and render ~139, with a comment that it is the legacy on-disk name of the project id). Jev analysis fields suggestedFolderId/folderConfidence are NOT renamed (stored data; listed as follow-up). Core i18n keys containing "Folder" (ChatFolderNotFound, ChatFolderNotSelected, ChatNoMeetingsInFolder, ...) keep their names; only their values are reworded later by the UI lane.

2. packages/core/src/projects/ (new module, index.ts exports all):
   - project.ts: PROJECT_NAME_MAX=120, PROJECT_DESCRIPTION_MAX=500, PROJECT_INSTRUCTIONS_MAX=20_000; interface Project {id, name, description, instructions, pinned, colorKey|null, iconKey|null, createdAt, updatedAt} (ISO-8601 UTC strings); ProjectListItem = Omit<Project,'instructions'> & {meetingCount, fileCount, lastActivityAt}; NewProject {name, description?, colorKey?}; ProjectPatch {name?, description?, instructions?, pinned?, colorKey?, iconKey?}; SkippedProject {dir, reason}.
   - project-file.ts: ProjectFile {id, name, kind: DocumentKind, sizeBytes, pages|null, truncated, textChars, sha256, addedAt}; PROJECT_FILE_MAX_FILES=25; PROJECT_FILES_MAX_TOTAL_CHARS=1_000_000; AddProjectFileResult = {ok:true,file} | {ok:false,name,reason: ProjectFileFailure}; ProjectFileFailure = 'not-found'|'unsupported'|'too-large'|'encrypted'|'no-text'|'unreadable'|'duplicate'|'project-full'|'not-a-project' (images are 'unsupported'). Reuses ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_CHARS, attachmentKindForName from core/chat/attachments.
   - errors.ts: StorageTooNewError(found, supported), ProjectFileCorruptError(path, reason).
   - ports.ts: ProjectRepository, ProjectFileStore, ProjectContextSource, StorageMigrationStatus (signatures in section 5 of docs/design/projects.md). ChatThreadRepository lives in packages/core/src/chat/chat-thread.ts (owned by the chat lane after this phase).
   - storage-layout.ts: pure createStorageLayout(libraryRoot, path: PathJoiner) with constants META_DIR_NAME='.vozella', INBOX_DIR_NAME='Inbox', STORAGE_SCHEMA_VERSION=1 and the path functions of the layout in section 4 (manifestFile, backupsDirectory, projectsDirectory, projectDirectory(id), projectJsonFile(id), filesDirectory(id), fileDirectory(id,fileId), chatsDirectory(ownerProjectId|null), threadFile(owner,id), inboxDirectory).
   - project-context.ts (FINAL implementation + tests, shared kernel): ProjectContextBudget {instructionsChars, filesChars}; projectBudgetFor(surface:'chat'|'live'|'summary', providerId) with the budgets of section 7; packProjectContext({name, instructions, documents, budget, query}): string|null (instructions neutralized and capped with cutPrefix; files through packAttachments(documents, budget.filesChars, query); labels PROJECT_INSTRUCTIONS_LABEL / PROJECT_FILES_LABEL exported; returns null when there is neither instructions nor documents).
   - in-memory-projects.ts: InMemoryProjectRepository, InMemoryProjectFileStore, InMemoryChatThreadRepository, InMemoryProjectContextSource fakes for every lane's tests.
   - project-service.ts: stub class ProjectService with the final public method signatures (list, get, create, update, setInstructions, delete, plus the helpers the controller needs); bodies throw 'not implemented' (replaced by the storage lane).
3. packages/core/src/chat/chat-thread.ts (final types, stub-free): ThreadOwner = string|null; ChatThread {schemaVersion:1,id,ownerProjectId,scope:{kind,meetingId|null},title,createdAt,updatedAt,messages:ChatMessage[]}; ChatThreadSummary {id,ownerProjectId,scope,title,updatedAt,messageCount}; ChatThreadRepository {list(owner), get(owner,id), save(thread), rename(owner,id,title), delete(owner,id), activity(): Promise<ReadonlyMap<ThreadOwner,string>>}. ChatService and scope-resolver behavior is NOT changed here beyond the rename. Shared kernel edit in packages/core/src/chat/context-packer.ts (final, with tests, then owned by the chat lane): LiveContextSnapshot gains projectId?: string|null and project?: string|null (a pre-packed project block); packLiveSession(live, budget, projectBlock?: string|null) places the block after the title/notes lines and before the digest; the Live case of packContext forwards snapshot.project. apps/desktop/src/main/recording/live-ask-handlers.ts LiveChatContext gains projectId: string|null (null until the recording lane fills it).
4. packages/contracts/src (zod only, no runtime deps beyond zod):
   - projects.ts: projectSchema, projectListItemSchema, projectFileSchema, projectFailureReasonSchema (enum: empty-name, name-taken, too-long, not-found, busy, corrupt, io-failed, trash-failed, storage-newer), projectFileFailureSchema, and the channels listed in section 6 (projects.list, projects.get, projects.create, projects.update, projects.setInstructions, projects.delete, projects.files.pick, projects.files.add, projects.files.remove, projects.migrationReport, projects.dismissMigrationReport, event projects.changed).
   - chat.ts additions: chatScopeKindSchema 'Folder'->'Project' and projectId in chatScopeSchema; chatThreadSummarySchema; chatStateSchema gains threadId (string|null); channels chat.threads.list, chat.threads.open, chat.threads.rename, chat.threads.delete, event chat.threads.changed.
   - library.ts: remove folderSchema/FolderDto and the five folder channels (createFolder, renameFolder, updateFolderPersonality, setFolderNote, deleteFolder); library.load output drops folders; meetingListItemSchema/meetingRecordSchema folderId->projectId; libraryMoveMeeting(s) take projectId; librarySearch scope {kind:'all'|'none'|'project', id}; libraryChanged reason enum 'meeting'|'project'|'location'; workspace state/action renames.
   - recording.ts: start/importUrl/import inputs folderId->projectId.
   - storage.ts (persisted formats, validated by platform adapters): libraryManifestSchema, projectRecordSchema (project.json), projectFileMetaSchema (files/<id>/meta.json), extractedTextSchema (files/<id>/extracted.json), chatThreadFileSchema (chats/<id>.json). Every schema has schemaVersion: z.literal(1) as a discriminator so v2 can be added as a union member with an upgrade function.
   - channels.ts / index.ts / wire.ts register all new channels; contract tests (zod round trip, strict inputs) for each new schema.
5. packages/platform/src/projects/ and chat stubs with FINAL factory signatures (stub bodies return the in-memory fakes; each lane replaces its own body, keeping the signature): project-repository.ts createProjectRepository({libraryRoot, logger, clock, newId, discard?}) [storage lane]; project-file-store.ts createProjectFileStore({layout, extractor, logger, clock, newId}) [context lane]; project-context-source.ts createProjectContextSource({projects, files}) [context lane]; packages/platform/src/chat/chat-thread-store.ts createChatThreadStore({layout, logger, clock, discard?}) [chat lane]; storage-migrator.ts migrateStorage(ctx): Promise<StorageMigrationStatus> with an empty MIGRATIONS registry [storage lane].
6. packages/platform/src/library/library-runtime.ts (storage lane owns the file after this phase): getters projects, projectService, projectFiles, chatThreads, projectContext built in build() from the factories above; LibraryRuntimeDeps gains extractor: DocumentExtractor; LibraryChangeReason = 'meeting'|'project'|'location'. platform/src/index.ts exports every new platform file once (barrel then belongs to the storage lane, which only removes deleted exports).
7. apps/desktop/src/main (Contracts owns until the end of the project): index.ts passes the shared threaded extractor to LibraryRuntime and projectContext/threads to composeChat, composeSummaries, composeRecording (their Deps interfaces gain those fields, minimal edit); new main/projects/compose-projects.ts registers registerProjectHandlers (storage lane file), registerProjectFileHandlers (context lane file), both stubbed; ipc/handlers.ts and compose-test-kit.ts updated. Lanes never edit index.ts, ipc/handlers.ts, compose-projects.ts or compose-test-kit.ts.
8. Tests: contracts schema tests, project-context.ts unit tests (budgets, neutralization, query ranking, null cases, local budget carve-out), storage-layout tests, in-memory fakes smoke tests. No UI, no locale changes.

OWNED BY CONTRACTS (lanes must not edit): packages/contracts/src/**, packages/core/src/index.ts, packages/core/src/projects/** except the three files owned by the storage lane, packages/core/src/chat/chat-thread.ts (until the chat lane starts), apps/desktop/src/main/index.ts, apps/desktop/src/main/ipc/handlers.ts, apps/desktop/src/main/projects/compose-projects.ts, apps/desktop/src/main/compose-test-kit.ts, apps/desktop/e2e/** (owned by the e2e phase). If a lane needs a contract change it stops and asks for a contract patch commit; it never edits those files.

NEW LOCALE KEYS: backend lanes add none. Failure reasons are enums; the UI lane maps them to strings. Existing core string keys keep their names.

### 13.2 Lanes

Rules for every lane: edit only the exclusive surfaces below (no file appears in two lanes); tests sit next to the code; no new barrel exports (public symbols go in files the Contracts phase created); no locale edits outside the UI lane; no edits to Contracts-owned files; `pnpm check` green before each commit; test first.

### `L1-storage` Storage, migration and project use cases

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/library/**`
- `packages/core/src/projects/project-service*.ts`
- `packages/core/src/projects/project-names*.ts`
- `packages/core/src/projects/project-personality*.ts`
- `packages/platform/src/library/**`
- `packages/platform/src/projects/project-repository*.ts`
- `packages/platform/src/projects/storage-migrator*.ts`
- `packages/platform/src/projects/migrations/**`
- `packages/platform/src/index.ts`
- `apps/desktop/src/main/ipc/library-handlers*.ts`
- `apps/desktop/src/main/ipc/projects-handlers*.ts`
- `apps/desktop/src/main/projects/projects-controller*.ts`
- `docs/port/stack.md`
- `docs/port/specs/library-storage.md`
- `docs/port/parity/library-storage.md`

Goal: replace the folder tree with flat projects on disk, migrate old libraries, and expose the project use cases. Read sections 3, 4, 5, 6 and 10 of docs/design/projects.md.

Build:
- core/projects: project-names (pure: validate name, fold for uniqueness with foldText, resolveMigratedNames for the collision rule of section 4.3), project-personality (move of folder-personality.ts: accent/icon keys, renamed), ProjectService (create, update, setInstructions, delete, list with lastActivityAt from ProjectRepository + MeetingRepository + ChatThreadRepository.activity + ProjectFileStore counts, pin, name-taken check with folded names, busy checks). delete() moves every meeting of the project to no project through MeetingRepository.batch first and aborts with the failure when any move fails; only then trashes the project directory through ProjectRepository.delete.
- core/library: LibraryService keeps load, search, moveMeeting(s), deleteMeeting(s) and loses every folder use case; LibraryView becomes all | none | project(id); remove nesting and WinUI code per section 10 (folder.ts, folder-tree.ts, folders-json.ts, folder-personality.ts, canDeleteFolder, FolderRepository, nameTaken parent logic, reserved Meetings/Recordings rule, legacy app-paths fields, chatThreadsFilePath); in-memory-library and workspace follow the rename.
- platform/projects: FileProjectRepository (project.json per project, atomic writes, per-project keyed mutex, zod validation with schemaVersion, frozen dir allocation, directoryOf, delete = discard() of the project storage directory), storage-migrator (manifest read/write, MIGRATIONS registry, newer-than-supported refusal, per-step manifest commit), migrations/001-folders-to-projects.ts and legacy-folders-reader.ts (the only code that knows the old folders.json shape: BOM, any key case, CRLF, offset dates), backup before first write, report stored in the manifest.
- platform/library: MarkdownMeetingRepository takes a MeetingPlacement (Pick<ProjectRepository,'directoryOf'>) instead of folders; scan skips dot-directories; drop legacy flat-dump logic (isLegacyFlatDump, isUserFolderDirectory, locate, legacy flag in prefer); library-runtime.build() runs migrateStorage and wires ProjectService; delete json-folder-repository.ts, the three legacy migrations in migrations.ts (user data location, library layout, meetings.json), winui-library test and fixtures; ensure-directories creates Inbox and .vozella only; library-layout loses directoryFor/folderDirectorySegments use.
- main: library-handlers lose folder channels, library.load returns meetings only, search takes the new scope; projects-handlers + projects-controller serve projects.list/get/create/update/setInstructions/delete/migrationReport/dismissMigrationReport and broadcast projects.changed and library.changed('project'). Controllers take the dialogs and discard (Electron shell.trashItem) as injected deps.
- docs: update docs/port/stack.md data-safety bullet (byte compatibility now applies only to meeting Markdown), mark the folders sections of docs/port/specs/library-storage.md superseded by docs/design/projects.md, and add parity-ledger rows (dropped: WinUI folders.json compatibility, nested folders; improved: projects).

Tests this lane adds:

Vitest, test first. Unit: project-names (collision rule cases: sibling-unique parents, deep chains, case/accent-insensitive collisions, existing root named like the prefixed result, numeric suffix order by createdAt then id, orphan parentId treated as root), ProjectService (name-taken folded, empty, too long, delete aborts when a meeting is busy or cannot move, lastActivityAt composition, pin), library-view, library-service moves. Platform integration with a temp VOZELLA_DATA_ROOT (mkdtemp, never real Documents): FileProjectRepository (atomic write, corrupt project.json is skipped and reported, dir allocation with collisions and reserved names, directoryOf unknown id = Inbox, concurrent updates serialized), storage-migrator (fresh install creates manifest v1 and no backup; newer manifest throws StorageTooNewError and writes nothing; failure in step leaves manifest unchanged), 001-folders-to-projects against a fixture legacy library (BOM, CRLF, PascalCase and camelCase keys, 3-level nesting, sibling-unique/global-colliding names, orphan parent, folder note -> instructions, ids preserved, dirs frozen to the old chain so zero files move, backup byte-identical to the original and created before any project.json, folders.json removed only after the manifest, second run is a no-op, resume after a crash injected after N projects, corrupt folders.json leaves no manifest and reports the error, meetings with unknown folderId read as no project), MarkdownMeetingRepository (project directory placement, move between projects moves md+wav+mic activity and rewrites audioFilePath, dot-directories ignored, duplicate id prefers newest mtime). Controllers/handlers: ipc tests with fakes. Contract: every channel input/output round-trips its zod schema.

### `L2-chat-threads` Chat persistence and project-aware chat context

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/chat/**`
- `packages/platform/src/chat/chat-thread-store*.ts`
- `packages/platform/src/chat/library-chat-reader*.ts`
- `apps/desktop/src/main/chat/**`
- `apps/desktop/src/main/ipc/chat-*`

Goal: persisted, listable, reopenable, deletable chat threads per project (and for no project), and project instructions/files in the chat prompt. Read sections 5, 6 and 7 of docs/design/projects.md.

Build:
- ChatService: add ChatThreadRepository and ProjectContextSource deps. A thread is created lazily on the first successful turn and saved after every successful turn (cancelled/failed sends persist nothing). Owner resolution at creation: scope Project -> scope.projectId; Meeting -> the meeting's projectId; Live -> LiveContextSnapshot.projectId; AllMeetings -> null. Title = first user message, single line, cut at 60 chars; rename supported. send() continues the open thread only when matchesOpenThread, otherwise starts a new thread (the old one stays in history). New methods: openThread(owner,id) (refused while sending), deleteThread, listThreads(owner), renameThread; state gains threadId. newChat() clears the open thread without deleting anything.
- scope-resolver: surface 'Projects' with selectedProjectId yields kind 'Project'; History/Record/Settings behave as before.
- context-packer: Project scope packs "Project: name" plus the project's meetings (instructions and files are NOT repeated there: they come from packProjectContext); Meeting and Live scopes prepend the project block when the owner project is known (Live: ChatService resolves snapshot.projectId through ProjectContextSource and fills snapshot.project before packing); AllMeetings never has one. ChatService.pack calls packProjectContext (Contracts kernel) with projectBudgetFor('chat', provider.id) and query = user text + last user turn; on the local engine the block size is subtracted from meetingChars so the total stays constant (section 7). Rename kind 'Folder' to 'Project' in prompt-builder and packers; core string KEYS unchanged.
- LibraryChatReader: meetingsInProject, listProjects replace the folder methods; project note removed (instructions come from ProjectContextSource).
- platform chat-thread-store: files at chats/<id>.json under the owner directory (layout from Contracts), zod chatThreadFileSchema, atomic write, per-owner keyed mutex, list by mtime-cached header parse, corrupt file skipped and logged, activity().
- main: chat-controller and chat-handlers add chat.threads.list/open/rename/delete and broadcast chat.threads.changed; compose-chat wires the new deps.

Tests this lane adds:

Vitest, test first. core: ChatService thread lifecycle with InMemoryChatThreadRepository (lazy create, save per turn, nothing saved on cancel/fail/empty answer, scope mismatch starts a new thread, openThread restores messages and scope, refused while sending, delete open thread resets state, owner resolution for all four scopes, title cut and rename), scope-resolver cases, context-packer Project/Meeting/Live with and without project block, local budget carve-out keeps total constant, project-context ordering (project block first), neutralization of forged "Id:" lines in instructions and files. platform: chat-thread-store round trip with a temp dir, corrupt file skipped, concurrent saves serialized, activity map, schemaVersion unknown -> skipped with reason. main: chat-controller thread methods and handler wiring with fakes, existing chat tests updated for the rename.

### `L3-context-files` Project files, context source and summaries

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/summaries/**`
- `packages/platform/src/projects/project-file-store*.ts`
- `packages/platform/src/projects/project-context-source*.ts`
- `apps/desktop/src/main/summaries/**`
- `apps/desktop/src/main/ipc/summaries-handlers*.ts`
- `apps/desktop/src/main/ipc/project-files-handlers*.ts`
- `apps/desktop/src/main/projects/project-files-controller*.ts`

Goal: copy project context files into project-owned storage with extracted text, serve them as context, and feed instructions and files to summaries. Read sections 4, 6 and 7 of docs/design/projects.md.

Build:
- platform project-file-store: add(projectId, sourcePath) validates the path (absolute, local, regular file, not UNC/device, kind via attachmentKindForName, not an image, <= ATTACHMENT_MAX_BYTES), checks PROJECT_FILE_MAX_FILES and PROJECT_FILES_MAX_TOTAL_CHARS, hashes the file (sha256, duplicate refused), extracts with the injected threaded extractor (reuse extractDocument/DocumentExtractor from platform/chat; do NOT modify those files), then commits atomically: files/<fileId>/original.<ext> (temp file then rename), extracted.json, meta.json written last (a directory without meta.json is an aborted add and is cleaned on next list). list, remove (discard to Recycle Bin when available), countByProject, readDocuments(projectId) returning AttachedDocument[] ordered by addedAt with an mtime-keyed in-memory cache.
- platform project-context-source: composes ProjectRepository.get + ProjectFileStore.readDocuments into ProjectContextData; null for unknown project.
- main: project-files-controller + project-files-handlers serve projects.files.pick (Electron open dialog through injected dialogs), projects.files.add (paths from a drop, validated again), projects.files.remove, and broadcast projects.changed with reason 'files'.
- summaries: SummaryService replaces the folders dep and folderNoteOf with ProjectContextSource; series-context and prompt-builders rename folderNote to projectInstructions, the <folder_note> block becomes <project_instructions> and a new <project_files> block carries packAttachments excerpts; query = meeting title + notes + first 2000 chars of the transcript; budgets from projectBudgetFor('summary', provider.id); on the local engine the blocks count against local-prompt-budget / local-map-reduce overhead so the existing 4096-token guarantee holds. The prompt line that explains <folder_note> is rewritten for the new blocks. Any failure reading project context leaves it out and the summary still runs (existing rule). compose-summaries passes the live proxy for projectContext; summaries-handlers follow the rename.

Tests this lane adds:

Vitest, test first. platform (temp dir): add copies the bytes and extracts text for txt/md/csv/docx/pdf/pptx fixtures from platform/chat/attachment-fixtures.ts, refuses images, oversize, encrypted, no-text, duplicates (same sha256 different name), file-count and total-chars limits, UNC paths; aborted add (no meta.json) is not listed and is cleaned; remove deletes the directory; readDocuments order and cache invalidation on add/remove; unknown schemaVersion in meta.json is skipped with a reason. context-source: null for unknown project, instructions plus documents for a known one. core summaries: prompt contains <project_instructions> and <project_files> only when present, instructions neutralized, files ranked by the query, remote vs local budgets, local prompt budget still under its limit with a full project block, failures in the context source never fail the summary; existing tests updated for the rename. main: controller/handler tests with a fake dialog and fake store.

### `L4-recording-live` Recording destination and live copilot project context

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/recording/**`
- `packages/core/src/live-ask/**`
- `packages/core/src/live-copilot/**`
- `apps/desktop/src/main/recording/**`
- `apps/desktop/src/main/live-copilot/**`
- `apps/desktop/src/main/ipc/recording-handlers*.ts`
- `apps/desktop/src/main/ipc/pill-handlers*.ts`

Goal: a take records into its project, and the live copilot sees the project instructions and files. Read sections 5, 6 and 7 of docs/design/projects.md.

Build:
- Recording destination: RecordingService/compose-recording use ProjectRepository.directoryOf(projectId) for audioDirectory and ProjectRepository.get for the existence check (resolveProject replaces resolveFolder; unknown project falls back to no project as today); entry-points use workspace.state.selectedProjectId as the fallback; recording.start and import (file, YouTube) take projectId; the take exposes projectId to the live ask. Starting a take never fails because a project was deleted meanwhile.
- Live copilot: LiveAskDeps.recording() returns projectId; LiveChatContext gains projectId. Today the Live scope ignores folders (scope-resolver ~46) and packLiveSession only packs title, notes and digest: add a project block. The pill/dock ask (LiveAskSession) resolves the block per question (query = the question) through ProjectContextSource and passes it to packLiveSession as its optional third argument (signature fixed by the Contracts phase; the function itself lives in core/chat and is not edited here), so the pill, the dock and the Live chat see the same context; budgets from projectBudgetFor('live', provider.id). The digest, question detection and local-model rules (never load the local model mid-take) are unchanged; a context read failure is logged and the ask goes on without it. The Live chat in the main chat service gets projectId from LiveChatContext (consumed by the chat lane through the existing liveContext callback shape).
- Pill/live handlers follow the rename; no new IPC channel is needed.

Tests this lane adds:

Vitest, test first. core: packLiveSession/live-ask-session with and without project block, ordering (session, project, digest, transcript), query passed to the source is the question, budget per engine, failure of the source does not break the ask, live-ask prompt-builder unchanged otherwise. main: recording-service saves into the project directory and falls back to no project when the project is gone, entry-points fallback to selectedProjectId, import-run and youtube-import pass projectId, live-ask-handlers chatContext carries projectId, pill-controller unaffected. All with fakes and temp dirs; existing recording tests updated for the rename.

### `L5-ui` Renderer: Projects tab, project page, no-project list, sidebar, record destination, chat history, locales

UI lane: yes

Edit surfaces (exclusive):

- `apps/desktop/src/renderer/**`
- `apps/desktop/src/main/i18n-catalog-checks.test.ts`
- `PRODUCT.md`
- `DESIGN.md`
- `docs/port/design-system.md`

Goal: the whole Projects experience, following the impeccable skill and docs/port/design-system.md (Operate mode: scanability, consistency, tokens only, hairlines, radius 4-6, sentence case, no exclamation marks, no emoji, no cards inside cards). Load frontend-design, impeccable and accessibility before any UI edit. Read section 8 of docs/design/projects.md and implement it exactly.

Build:
- features/projects/ (new, containers and presentational parts split per the stack rules): ProjectsRoute (grid, New project dialog, search, sort, pinned group, No project row, empty states, migration notice), ProjectRoute (header, primary action, tabs Meetings/Chats, right panel Instructions and Context files, menu Rename/Edit description/Pin/Delete), NoProjectRoute (same frame, no right panel), MoveToProjectDialog (searchable flat list, used by the Library list, bulk bar, meeting preview and session header), ProjectCard, InstructionsDialog, ProjectFilesPanel, ChatThreadList, use-projects store (zustand, listens to projects.changed), use-project, use-project-files, use-chat-threads. Start meeting in this project: navigate to /record?project=<id>&start=1; RecordRoute sets the destination and runs the same ensure-ready + start flow as the Record button.
- router.tsx: /projects, /projects/$projectId, /projects/none; navigation.ts and NavRail: rail Record, Projects, Library, Settings; tagOfPath/routeOfTag/railRouteOf handle 'Projects' (a project page keeps Projects selected); AppShell publishes selected project (publishSelectedProject) on the project page and clears it on leave.
- features/library: remove the tree, Breadcrumbs, LibraryFolders, use-folder-note, folder dialogs, expandedAncestors and every folderChain use; the Library route becomes the flat all-meetings list with a project filter (All projects, No project, one project) feeding librarySearch scope; keep filters, bulk actions (Move becomes Move to project), preview, undo. folder-visuals becomes project visuals (accent and icon keys kept). Remove ui/Tree.tsx, tree-navigation.ts and their gallery entries.
- features/record: destinations are projects flat (No project first, then pinned, then by name), copy uses "No project" instead of Inbox; use-recording and RecordIdle use projectId.
- features/chat: AiPanel gets a History control (popover list of threads for the current owner, New chat, open, rename, delete via chat.threads.*), scope label for Project scope; use-chat-scope maps the workspace to the new scope kinds.
- features/session and others: replace folder wording and folderId usages; SessionHeader offers Move to project.
- i18n: add every new key to ui.en.json and ui.es.json (same placeholders and order, parity test), reword every existing value that says folder/carpeta/Inbox in the library sense to project/proyecto/No project / Sin proyecto, keep existing key names that core still references. es is the user's primary language: natural Latin American Spanish, sentence case.
- Docs: PRODUCT.md terminology (project, no project), DESIGN.md folder accent tokens renamed in prose only (token names unchanged), design-system.md kit list (Tree removed).

Tests this lane adds:

Vitest + Testing Library (jsdom), test first for logic: sort/search/pin ordering, last-activity label, move-to-project filtering, use-projects store reacting to projects.changed, navigation helpers, record destinations ordering, thread list model. Component tests for ProjectsRoute (empty, populated, pinned, search no results, create dialog name-taken and empty-name), ProjectRoute (tabs, instructions edit save/cancel/limit counter, add file pending/ready/error rows, remove file, delete confirmation text), NoProjectRoute (Move to project single and bulk), MoveToProjectDialog keyboard, AiPanel History (list, open, delete), RecordRoute autostart from /record?project=<id>&start=1, Library project filter. Accessibility: accessible names on every icon button, focus order, dialogs trap focus, no color-only state (jest-axe if already used, else the existing axe helpers). i18n-catalog-checks parity must pass with both locales. All IPC through a typed mock of window.vozella.invoke.

### 13.3 Dependencies between lanes

All lanes depend only on the Contracts commit. Cross-lane needs are met by Contracts-owned types, ports, fakes and stubs: the UI lane codes against the typed IPC channels with a mocked `window.vozella`; the chat, summary and live lanes code against `ProjectContextSource` and `packProjectContext` with the in-memory fakes; the storage lane's `LibraryRuntime` already calls the other lanes' factory functions.

### 13.4 Merge order

1. contracts
2. L1-storage
3. L3-context-files
4. L2-chat-threads
5. L4-recording-live
6. L5-ui
7. integration (pnpm check, remove leftover stubs, resolve barrels)
8. e2e

Storage first because it owns the platform barrel and `LibraryRuntime`; context and chat before recording because `LiveChatContext` is consumed by both; UI last because it is the largest and imports every channel. Integration removes any stub left behind, runs `pnpm check`, then the Playwright run.

### 13.5 E2E

One Playwright spec: apps/desktop/e2e/projects.spec.ts (plus updates to library-data.ts to seed projects and to the existing library*.spec.ts that still reference the folder tree, which are deleted or rewritten here). Run with VOZELLA_E2E_BACKGROUND=1 pnpm test:e2e (never pops windows); every launch uses launchApp/launchAppInRoot with a mkdtemp VOZELLA_DATA_ROOT and VOZELLA_FAKE_NATIVE=1, never a real Documents folder. Chat and live prompts are observed through the existing promptLogFile double; the file picker through the same dialog double chat-attachments.spec.ts uses.

Scenarios (serial where they share a root):
1. Migration on first launch: seed a legacy library (folders.json with BOM and CRLF, folders Universidad > Calculo and Trabajo > Calculo, a root folder with a note, an orphan parentId, 4 meetings with folderId plus 1 in Inbox and 1 with an unknown folderId). Launch. Projects shows one card per old folder, the colliding ones named "Universidad – Calculo" and "Trabajo – Calculo", the note shows as Instructions of its project, the No project row counts Inbox plus the unknown-folder meeting, meetings open from their cards and links https://meetinglive.local/meeting/<id> still resolve; .vozella/backups contains a byte-identical copy of folders.json and folders.json is gone; the migration notice appears once and dismisses.
2. Idempotent relaunch: close, launchAppInRoot on the same root; same projects, no second backup, no notice; then seed schemaVersion 99 in .vozella/library.json, relaunch: the app shows the newer-version notice, meetings still list, and the manifest is untouched.
3. Create and organize: New project with empty name is refused, a duplicate name (different case/accent) shows name-taken, a valid name creates the card; pin moves it to the Pinned group; search and each sort option order the grid; rename and edit description from the project menu.
4. Project page: Edit instructions (counter, cancel keeps old, save persists across relaunch); Add context file through the picker double (txt and a small pdf/docx fixture) appears with size and pages, duplicate refused, unsupported image refused with a message, Remove deletes it; the file copy exists under .vozella/projects/<id>/files and the original path is untouched.
5. Start meeting in this project: primary button opens Record with the project as destination and starts the take (fake audio); stop; the meeting appears first in the project's Meetings tab, its file sits in the project directory, and it is absent from No project.
6. Context reaches the models: with a ready fake provider, a project chat message produces a prompt (promptLogFile) containing the instructions and an excerpt of the file ranked by the question; the Live copilot ask during scenario 5 contains the instructions; generating a summary prompt contains <project_instructions> and <project_files>; a meeting in another project does not.
7. Chat history: send two chats in the project (Project scope) and one in No project; the Chats tab lists only the project's threads newest first; New chat starts another; relaunch and reopen a thread: messages are back and sending continues it; rename; delete removes the file under chats/ and the row; AiPanel History shows the same list.
8. No project and Move to project: the No project page lists unfiled meetings; Move to project from a row menu and from the bulk bar (3 meetings) moves them, the md/wav files move to the project directory, counts on the cards update, undo works; Library page project filter shows All projects / No project / one project.
9. Delete project: confirm text names the meeting count; after confirming the meetings are in No project, files and chats of the project are gone from disk (or in the fake trash), and the card disappears.
10. Quality: axe (serious and critical = 0) on Projects, a project page and No project in light and dark; keyboard only: create a project, open it, add instructions, start a meeting; switch to Spanish: no raw keys and no "folder/carpeta/Inbox" wording anywhere in these screens; reduced motion honored.
