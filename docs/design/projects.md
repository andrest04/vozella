# Flat projects

Design for replacing nested Library folders with flat, Claude-style Projects in Vozella. Branch `feat/projects`. Status: design revision 2 (after the architecture critique, see section 12), ready for the Contracts phase.

How to read this: sections 1 to 3 say what and why, 4 to 7 say how it is stored and wired, 8 is the UI and how it follows the impeccable skill, 9 to 11 are tests, removals and risks, 12 records decisions and the answer to each critique point, 13 is the implementation plan (Contracts phase, five parallel lanes, merge order, e2e, e2e).

## 1. Goals

- A project is a flat container for related meetings, with instructions and context files that the assistant uses everywhere it speaks: the Live copilot, chat and summaries.
- The Projects tab is a grid of project cards. A project page has a primary action, "Start meeting in this project", a Meetings tab, a Chats tab, and a right panel with Instructions and Context files.
- Meetings with no project stay first-class: a "No project" list with "Move to project".
- Chat history is persisted per project (and for no project): listable, reopenable, deletable.
- Existing libraries migrate once, automatically, without moving a single meeting file, with a verified backup, and idempotently. Every old folder, including subfolders, becomes its own project and keeps its id. A malformed old folder list can never lose or overwrite data.
- Storage is versioned with forward migrations so the next change is a new migration, not a rewrite. One module per feature, core stays pure, platform implements ports, contracts hold the zod schemas.
- The new storage is plain TypeScript. The only native code remains the small Rust addon that the OS forces (audio, calendar, sessions, windows); this feature adds no Rust.
- The whole Projects tab follows the impeccable skill: Operate mode, its vocabulary, its refusals (section 8.0).

## 2. Non-goals

- Memory, Scheduled, project sharing, archiving, nested projects, tags, project templates, per-project accent colors or icons (section 12, decision 8).
- Image files in a project (v1 supports PDF, DOCX, PPTX, TXT, MD, CSV, the same extractors as chat attachments, minus images).
- Drag and drop of files onto the project panel (the picker is v1; drop reuses the preload bridge later).
- Embeddings or a database. Retrieval stays BM25 in memory (stack.md: no database until a measured need).
- Renaming the Jev analysis field `suggestedFolderId` (stored meeting data; a blanket search and replace must exclude it) and the `{0}` placeholder syntax of the locale catalogs (our template syntax; not touched).
- Importing the three pre-Documents layouts of earlier versions (app data `Meetings`/`Recordings`, `meetings.json`). They are detected and reported, not imported (section 4.5, decision 3).
- Cloud sync, cloud AI. Context never leaves the PC except to the engine the user already chose for that send, as today.

## 3. Domain model

Names are final; core types live in `packages/core/src/projects` and `packages/core/src/chat/chat-thread.ts`, zod mirrors in `packages/contracts`.

```ts
interface Project {
  readonly id: string;            // canonical lowercase GUID; migrated projects keep the folder id
  readonly name: string;          // 1..120 chars, unique by folded text (case and accent insensitive)
  readonly description: string;   // 0..500, shown on the card and the page header
  readonly instructions: string;  // 0..20_000, the former folder note for migrated projects
  readonly pinned: boolean;
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

type ThreadOwner = string | null;           // project id; null is "no project"
interface ThreadScope {                     // what the renderer sees and pins
  readonly kind: 'AllMeetings' | 'Project' | 'Meeting' | 'Live';
  readonly projectId: string | null;        // always the owner
  readonly meetingId: string | null;        // set for Meeting only
}
interface ChatThread {                      // stored form
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ownerProjectId: ThreadOwner;
  readonly scope: { kind: ThreadScope['kind']; meetingId: string | null };
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
- Every id that reaches a path (project, file, thread) is a canonical lowercase GUID: parsed once at the boundary by the shared `parseGuid` (core), lowercased, and rejected otherwise. Lowercasing is what stops two ids that differ only by case from landing on the same NTFS path.
- Thread owner is resolved when the thread is created: scope Project uses that project, Meeting uses the meeting's project, Live uses the take's project, AllMeetings is no project. A thread stays with its owner even if the meeting moves later. This is what makes "Chats of a project" include its meeting chats.
- A thread whose Meeting scope points at a meeting that no longer exists is kept and opens read-only (section 6, "Opening a thread"). Threads are never deleted as a side effect of deleting a meeting; they are deleted with their project.
- Chat attachments stay per conversation and are not persisted; a message stores only the attachment names for display.
- Project files are not meetings: they are never indexed, searched as meetings, or shown in the Library.
- Sort keys on the grid: Recent activity is `lastActivityAt`, Name is folded text, Newest is `createdAt` (descending).

## 4. Storage

### 4.1 Layout on disk

```text
<Library>/                              default Documents\Vozella; location is user-selectable (unchanged)
  Inbox/                                meetings with no project: *.md + *.wav (unchanged)
  <project dir>/                        meetings of one project: *.md + *.wav (+ mic activity files)
  .vozella/                             ours; dot-directories are never scanned for meetings
    library.json                        manifest: schemaVersion, migration log, pending notice
    backups/
      folders.v0.<UTC timestamp>.json   byte-for-byte copy of the old folder list (never pruned)
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

Why meetings stay outside `.vozella`: they are the user's files, usable in any editor (PRODUCT.md "Meetings are files"). Why project data is inside the Library and not in app data: it travels with the meetings when the user moves or backs up the Library, which the old folder list already did and `chat-threads.json` never did. The manifest lives per Library root (section 4.4), because the data does.

### 4.2 Formats and versioning

Plain UTF-8 JSON, LF, two-space indent, no BOM, camelCase keys, ISO-8601 UTC dates, written with `writeFileAtomic` (temp file, rename) under a per-path keyed mutex. No CRLF, no escaping tricks, no case-insensitive key reading in the new readers (the one legacy reader is quarantined in section 4.5).

```json
// <Library>/.vozella/library.json
{
  "schemaVersion": 1,
  "createdAt": "2026-11-16T14:03:00.000Z",
  "migrations": [
    { "id": "001-folders-to-projects", "appliedAt": "2026-11-16T14:03:01.120Z",
      "report": { "source": "library", "projects": 7, "renamed": [{ "id": "…", "from": "Cálculo", "to": "Universidad – Cálculo" }],
                  "skipped": [], "legacyLeftovers": [], "backup": "backups/folders.v0.20261116T140300Z.json", "backupSha256": "…" } }
  ],
  "pendingNotice": { "kind": "folders-to-projects", "projects": 7, "renamed": 2, "skipped": 0, "leftovers": 0 }
}

// <Library>/.vozella/projects/<id>/project.json
{
  "schemaVersion": 1,
  "id": "9f1c…", "name": "Universidad – Cálculo", "description": "", "instructions": "Resumir en español…",
  "pinned": false,
  "dir": "Universidad/Cálculo",
  "createdAt": "2025-03-02T15:00:00.000Z", "updatedAt": "2025-03-02T15:00:00.000Z",
  "origin": { "kind": "folder", "parentId": "1b7e…", "originalName": "Cálculo" }
}
```

One version rule, enforced three ways. The manifest `schemaVersion` is the only version that gates opening a library; every persisted shape belongs to it.

| Change | Mechanism | Cost |
| --- | --- | --- |
| Layout or fields of any file kind | Bump `STORAGE_SCHEMA_VERSION` in the manifest and add one entry to the ordered `MIGRATIONS` registry (it may be a no-op when readers upgrade lazily). Add the new per-kind version to that kind's zod union with an `upgrade` function | Once per library, or none at startup |

1. A per-kind `schemaVersion` (project, file meta, extracted text, thread) is a zod discriminator for in-memory upgrade. It may never be bumped without the manifest bump and a `MIGRATIONS` entry in the same commit, so an older app refuses the whole library instead of skipping files. A unit test asserts that `max(per-kind versions) <= STORAGE_SCHEMA_VERSION` and that every bump has a registry entry.
2. A manifest newer than the app (`schemaVersion > STORAGE_SCHEMA_VERSION`) throws `StorageTooNewError`. The state becomes `newer`: nothing is written under `.vozella`, project writes fail with `storage-newer`, meetings keep working and keep their placement (section 4.4).
3. Defence in depth for files that slip through (a project folder copied in by hand, a half-synced library): a project, file meta or thread whose own `schemaVersion` is newer than the app is surfaced as `unsupported` (listed in `skipped` with that reason, its dir and name stay reserved, every write to it is refused with `storage-newer`), never silently skipped. A corrupt JSON is reported as `corrupt` the same way, never deleted and never blocking the rest.
4. Read-modify-write never drops unknown keys: every persisted schema is a loose object (zod 4 `z.looseObject`), unknown keys are carried through the update and written back. A test per file kind rewrites a file with an extra key and compares.

### 4.3 Project directories

The directory of a project, `dir`, is chosen when the project is created and then frozen. Renaming a project changes only the name. This removes the old directory move plus the rewrite of every `audioFilePath` and the reserved-name rules. Trade-off: after a rename the folder in Explorer keeps the old name. Moving a meeting between projects still moves its `.md`, `.wav` and mic activity file through `MarkdownMeetingRepository.save` (existing behavior, now one level).

Validation of `dir` (a read from disk is untrusted: a corrupt or hand-edited file must not be able to aim a write or delete outside the Library):

- The zod schema (`projectDirSchema` in contracts) rejects at parse time: empty, absolute, drive letter or `:`, backslash, leading or trailing `/`, empty segment, `.` or `..` segment, any segment starting with a dot (so `.vozella` is impossible), over 260 characters.
- `isSafeProjectDir` (core, pure, authoritative) additionally rejects: Windows reserved device names (`CON PRN AUX NUL COM1-9 LPT1-9`, with or without an extension), a segment ending in a dot or a space, the characters `< > : " | ? *` and controls.
- `directoryOf` resolves `path.join(libraryRoot, ...segments)` and asserts `isUnder(libraryRoot)` again after `path.resolve` and that it is not under `.vozella`. Any failure makes the project `skipped` with reason `unsafe-dir` (reported in the notice and the log), and `directoryOf(id)` answers Inbox for reads. Writes that need a project directory (a move, a new take) are refused for a skipped project: the take falls back to no project, a move returns `corrupt`.
- A frozen `dir` is never used for deletion. `ProjectRepository.delete` discards only `.vozella/projects/<id>` (section 5). A migrated parent's dir contains its children's dirs on disk; discarding it would trash their meetings, so nothing ever discards a project dir.

Allocation of the `dir` of a new project (pure `allocateProjectDir(name, taken)` in core, with the on-disk part in the repository):

1. Sanitize the name: remove `< > : " / \ | ? *` and controls, collapse whitespace, strip leading dots, trailing dots and spaces, cut at 80 characters; empty becomes `Project`; a Windows reserved name gets the suffix `" project"`. Always exactly one segment for a new project.
2. Fold the candidate with `foldText` (lower case, accents removed, the same fold as project names, which also matches NTFS case-insensitivity). The candidate is taken if its fold equals the fold of: `Inbox`; any entry of the Library root read with `readdir` at allocation time (user-made folders, a legacy `Meetings` or `Recordings`, anything else); any frozen `dir` of any project; and any first segment of a nested frozen `dir`. So a new project can never be a prefix or a child of another project's dir (the migrated `Universidad/Cálculo` makes `Universidad` taken).
3. If taken, try `" 2"`, `" 3"` … until free.
4. Reserve by `mkdir` without `recursive` (EEXIST moves to the next suffix), then write `project.json` atomically. If the write fails the empty directory is removed. A crash between the two leaves an empty directory that the next allocation avoids.

### 4.4 Storage lifecycle, read-only mode and ordering

A single `StorageState` is held by the library runtime and read by every storage adapter:

```ts
type StorageState =
  | { status: 'migrating' }
  | { status: 'ready' }
  | { status: 'error'; message: string }                 // a migration step threw or the legacy list was unreadable
  | { status: 'newer'; found: number; supported: number }; // StorageTooNewError
```

- `LibraryRuntime.build()` is the only place that builds services. It constructs the repositories into locals, runs `migrateStorage` to completion, and only then publishes them. Today `services` is assigned before the migrations run; that assignment moves after. Every getter (`projects`, `projectService`, `projectFiles`, `chatThreads`, `projectContext`, `meetings`, `service`) goes through `ready()` and waits on the in-flight build, so no handle exists before the manifest does, and no meeting save can run before migration settled. A failing build still publishes the services, in state `error` or `newer`.
- Unless the state is `ready`, ProjectRepository, ProjectFileStore and ChatThreadRepository are read-only: every write (create, update, delete, file add and remove, thread save) returns `{ ok: false, reason: 'storage-migrating' | 'storage-error' | 'storage-newer' }` and writes nothing; `list` returns what is readable plus the state. The UI shows the state (section 8.6). Chat keeps working without persistence and says so (`historySaved: false` in `chat.state`).
- Meetings never depend on projects to stay safe. `MeetingPlacement.directoryOf(projectId)` returns an absolute path, or `null` meaning "cannot place now" (state not ready, or a skipped project). `MarkdownMeetingRepository.save` then keeps an existing meeting exactly where it is (no move, no `audioFilePath` rewrite, frontmatter `folderId` untouched) and writes a new meeting to Inbox. Test: saving the notes of a meeting of project P while the state is `error` moves nothing.
- A Library location change (`library.changed` with reason `location`, from `LibraryRuntime.setLocation`) calls `build()` for the new root: the manifest is per Library root, so `migrateStorage` runs on the new root before the new services replace the old ones, and the old ones keep serving until then. Other composition roots read the services through `liveRepository(() => library.x)`, so a stale handle cannot survive the swap. Integration test with two temp roots (section 9).

### 4.5 Migration: old folder list to projects (storage version 0 to 1)

Version 0 means "no manifest". `migrateStorage` (platform) reads the manifest, refuses a newer one, then applies every migration whose version is greater than the current one, in order. After each successful step it atomically writes the manifest with the new `schemaVersion` and a log entry. A throwing step stops the run, is logged, sets the state to `error` (the existing StartupNotice shows it), and leaves the manifest as it was, so the next launch retries.

This replaces the three legacy steps of `runStartupMigrations` and, by decision, does not keep `migrateUserDataLocation` and `migrateLibraryLayout` as ordered steps before 001 (critique 1, section 12). What replaces their one load-bearing effect, finding the folder list, is step 1 below.

Step `001-folders-to-projects` is split into a pure plan and the writes.

1. **Find the source (read-only).** Candidates in order: `<Library>/folders.json`, then `<appData>/folders.json` (the location the old user-data migration used to move into the Library; a user who never ran it still has the list there). The first that exists is the source; the other one, if present, is only reported (`ignoredSource`) and left untouched. None exists means an empty list (fresh install): manifest v1, no backup, no notice. A source that cannot be read or parsed stops the step with state `error` and no manifest; meetings keep listing as "no project". Also detect, never import, the older layouts (`<appData>/Meetings`, `<appData>/Recordings`, `<appData>/meetings.json`): they are listed in `report.legacyLeftovers` and the notice says so.
2. **Parse and validate (pure, no writes).** The legacy reader (`migrations/legacy-folders-reader.ts`, the only code that still knows that shape: strips a BOM, accepts any key case) yields raw entries. Then `planProjects(entries)` in core:
   - Ids: `parseGuid` (it already returns the lowercase hyphenated form). An entry without a valid id is skipped and reported (`skipped: [{ index, reason: 'invalid-id' }]`): no meeting can reference an id that does not parse.
   - Duplicate ids (after lowercasing): the first entry in file order wins, later ones are dropped and reported (`reason: 'duplicate-id'`). This happens before any write, so two `project.json` writes can never target one path.
   - Parents: an entry whose ancestor chain revisits a node, points at itself, or is deeper than `MAX_CHAIN_DEPTH = 32` becomes a root (so `A -> B -> A` makes both roots); a parent that does not exist is a root (the old B26b rule, applied once here and never again). No loop can run: every walk carries a visited set and the depth cap.
   - Names: trimmed; empty becomes `Project`; cut at 120 characters; then the collision rule below.
3. **Name resolution** (pure `resolveMigratedNames` in core). Order folders by depth, then `createdAt`, then id, so results are deterministic. A name unique across all folders (compared with `foldText`) is kept. For colliding names every colliding folder that has a parent is renamed `<parent name> – <name>` (en dash with spaces) with the parent's original name: `Cálculo` under `Universidad` becomes `Universidad – Cálculo`. If that still collides, use the whole ancestor chain joined with `" – "`. If it still collides, append `" 2"`, `" 3"` in the same deterministic order. Root folders always keep their name; if a renamed result collides with one, the renamed folder gets the numeric suffix.
4. **Directories.** `dir` is the old chain path under the Library root, computed by a frozen copy of the old segment rule that lives only in this migration module (sanitized names, the `" folder"` suffix for `Inbox`, `Meetings`, `Recordings`). Because the files stay where they are, no meeting, recording or audio path is touched and the step cannot orphan data. If the computed chain fails `isSafeProjectDir` (for example a name that sanitizes to nothing, or a cycle-broken root whose chain no longer matches), the project gets a fresh dir from `allocateProjectDir` instead. Two migrated projects may share a dir when the old rule made them collide; that is harmless because nothing discards a dir. A parent and a child end up as two independent projects whose directories happen to be nested on disk; nothing in the code treats that as a relationship.
5. **Back up first.** Copy the source to `.vozella/backups/folders.v0.<UTC>.json` (never overwrites, counter on clash). Verify by re-reading the copy and comparing `sha256` with the source (a length match is not enough). A missing, unreadable or different backup deletes the attempt and aborts the step with nothing else written (test). If an earlier attempt left a backup whose hash equals the current source, it is reused instead of creating a second one. The backup is the only record of the old hierarchy and of the old accent colors once the source is deleted (`origin` keeps `parentId` and `originalName`); it is never pruned or deleted by the app.
6. **Write projects.** For each planned project, write `projects/<id>/project.json` atomically: id kept, `instructions = note ?? ""`, `description = ""`, `createdAt` converted to the same instant in UTC, `updatedAt = createdAt`, `origin` recorded. Same input gives the same bytes, so a crash after N projects is resumed by rerunning the step (state stays read-only until the manifest exists, so nothing else can have written here).
7. **Commit.** Write the manifest (version 1, log entry with the report and `backupSha256`, `pendingNotice`). Only then delete the source (best effort). If the delete fails (EBUSY, permissions) the manifest stays at 1, the step does not rerun, no second backup is made, and each later launch retries the delete once, only when the file's hash still equals the backup's (a changed file is left alone and logged). Test.
8. The UI shows the notice once, from `pendingNotice` (copy in section 8.6), and dismissing it clears it.

Idempotency: manifest version 1 skips the step. Rerunning a half-finished step recomputes the same plan and overwrites the same files. Fresh installs run the same code with no source: manifest v1, no backup, no notice.

### 4.6 Meeting repository and the directory mirror

The tree on disk stops being a mirror of a hierarchy. It becomes "one directory per project, plus Inbox", with the name frozen in `project.json`. Meetings are found by scanning, as today, and their project is the frontmatter id, so the mirror is cosmetic. Dot-directories are skipped by the scanner. The legacy flat-dump handling (`Library/Meetings`, `Library/Recordings` special cases, `isLegacyFlatDump`, `locate`, the `legacy` flag in `prefer`) is deleted; files that sit in such directories are ordinary meetings found by the same scan.

Duplicate meeting ids (the same id in two files, for example a copied folder) resolve deterministically: newest modified time wins, ties broken by path (ascending, case-folded). The shadowed copy is logged and returned in `library.load` as `shadowed: { id, keptPath, shadowedPath }[]`, and is never deleted, moved, or rewritten: `save`, `move` and `delete` act on the winner's path only. Deleting a winner together with its audio never removes an audio file that a shadowed copy still references (the scan keeps each shadowed copy's `audioFilePath`). Tests: the shadowed copy's `audioFilePath` and files are untouched by a move and by a delete of the winner; the tie-break is stable.

## 5. Ports and adapters

Dependency direction as in stack.md: `apps/desktop → platform → core`, `contracts` shared. Each port has one adapter and one in-memory fake in core (used by every lane's tests). Writes answer with a value, never a throw: `Result<T> = { ok: true; value: T } | { ok: false; reason: ProjectFailure }`.

```ts
// packages/core/src/projects/ports.ts
type ProjectFailure =
  | 'empty-name' | 'name-taken' | 'too-long' | 'not-found' | 'busy' | 'corrupt'
  | 'io-failed' | 'trash-failed'
  | 'storage-migrating' | 'storage-error' | 'storage-newer';

interface ProjectRepository {                 // adapter: FileProjectRepository (platform/projects)
  state(): StorageState;
  list(): Promise<{ projects: Project[]; skipped: SkippedProject[] }>; // SkippedProject {id|null, dir|null, reason: 'corrupt'|'unsupported'|'unsafe-dir'}
  get(id: string): Promise<Project | null>;
  create(input: NewProject): Promise<Result<Project>>;       // allocates id and the frozen dir (4.3)
  update(id: string, patch: ProjectPatch): Promise<Result<Project>>;
  delete(id: string): Promise<Result<void>>;                  // discard() of .vozella/projects/<id> ONLY, never of dir
  directoryOf(id: string | null): Promise<string | null>;    // absolute; null id or unknown id = <Library>/Inbox; null = cannot place now (4.4)
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
  list(owner: ThreadOwner): Promise<ChatThreadSummary[]>;     // newest first
  get(owner: ThreadOwner, id: string): Promise<ChatThread | null>;
  save(thread: ChatThread): Promise<Result<void>>;
  rename(owner: ThreadOwner, id: string, title: string): Promise<boolean>;
  delete(owner: ThreadOwner, id: string): Promise<boolean>;
  activity(): Promise<ReadonlyMap<ThreadOwner, string>>;      // last updatedAt per owner, for cards
}
```

- `MarkdownMeetingRepository` receives a `MeetingPlacement = Pick<ProjectRepository, 'directoryOf'>` instead of the folder repository. It keeps its index, folded-text cache and batch semantics, and the "keep in place when `null`" rule of section 4.4.
- `ProjectService` (core) holds the use cases: create, update (name uniqueness by folded text), setInstructions, pin, list (computes `meetingCount`, `fileCount` and `lastActivityAt = max(project.updatedAt, newest meeting recordedAt, chat activity)`, plus the no-project count and last activity), delete.
- **Delete is idempotent and resumable.** A batch of file moves (`.md`, `.wav`, mic activity) is not atomic, so delete never claims atomicity. Steps: (1) refuse with `busy` while a meeting of the project is recording or processing; (2) enumerate the meetings whose project id is this one at that moment; (3) move each to no project through `MeetingRepository.batch` (each move is itself idempotent, a meeting already moved is simply not enumerated again); (4) only when none remain, `ProjectRepository.delete` discards `.vozella/projects/<id>` (Recycle Bin through the injected `discard`, recoverable), which takes the instructions, files and chats with it. If a move fails the project is kept and the result is `{ ok: false, reason: 'partial', moved, remaining }` (counts, so the UI can say "Moved 9 of 12 meetings; try again"). Re-running delete moves the rest. A crash between moves leaves a consistent state (some meetings in no project, project still listed) and the same call finishes the job. An empty directory left by a deleted project is removed only with a non-recursive `rmdir` and only when no other project's `dir` equals or lies under it. Tests: crash between two moves then re-run; a migrated parent with a child's dir inside it keeps the child's meetings and dir after the parent is deleted.
- `LibraryRuntime` keeps owning "where the library lives" and rebuilds every service when the location changes; it builds the project repository, service, file store, thread store and context source and runs `migrateStorage` (section 4.4 for the ordering). Other composition roots read them through `liveRepository(() => library.x)`.
- Main-process controllers are thin: they validate with zod (done by `registerRequest`), call the service, broadcast `projects.changed` / `library.changed`.
- Patterns, each with a forcing problem: Hexagonal ports because storage and extraction vary (fs now, something else later) and core must stay pure; a registry of ordered migrations because layout changes will recur and must not be one growing function; a Result value because storage can be read-only (`StorageState`) and the UI must name the reason. No factories beyond the four `create…` functions that the composition root needs.

## 6. IPC contracts

Zod schemas in `packages/contracts/src/projects.ts` and `chat.ts`; same `defineRequest`/`defineEvent` style as today. Every answer is a value, never a thrown error.

| Channel | Input | Output |
| --- | --- | --- |
| `projects.list` | {} | ok: `projects: ProjectListItem[]`, `noProject: { meetingCount, lastActivityAt: string or null }`, `skipped`, `storage: StorageStateDto` |
| `projects.get` | {id} | ok: `project: Project, files: ProjectFile[]` / failure |
| `projects.create` | {name, description?} | ok: project / failure `empty-name, name-taken, too-long, storage-*, io-failed` |
| `projects.update` | {id, name?, description?, pinned?} | ok: project / failure |
| `projects.setInstructions` | {id, instructions} (max 20_000) | ok: project / failure |
| `projects.delete` | {id} | done / failure `busy, not-found, trash-failed, storage-*` / `partial {moved, remaining}` |
| `projects.files.pick` | {projectId} | opens the picker in main; `results: AddProjectFileResult[]`, or empty on cancel |
| `projects.files.add` | {projectId, paths[]} (max 10) | `results[]`; paths re-validated in main |
| `projects.files.remove` | {projectId, fileId} | `{removed}` |
| `projects.migrationReport` / `projects.dismissMigrationReport` | {} | report (`pendingNotice` plus renamed list, skipped, leftovers) or null / {} |
| `projects.changed` (event) | | {reason: 'project' or 'files', projectId or null} |
| `library.load` | {} | meetings, skipped and `shadowed` (no folders) |
| `library.moveMeeting`, `library.moveMeetings` | {…, projectId: string or null} | as today, plus failure `storage-*` |
| `library.search` | {query, scope: all or none or project(id), requestId} | as today |
| `library.changed` (event) | | reason: meeting, project, location |
| `workspace.dispatch` action `publishSelectedProject` | {projectId: string or null} | the new `workspace.state` (below) |
| `chat.threads.list` | {projectId: string or null} | {threads: ChatThreadSummary[]} |
| `chat.threads.open` | {projectId, id} | see "Opening a thread" |
| `chat.threads.rename` / `chat.threads.delete` | {projectId, id, title?} | {ok} |
| `chat.threads.changed` (event) | | {projectId} |
| `chat.state` | | adds `threadId: string or null` and `historySaved: boolean` |
| `chat.setScope` | scope with `kind: Project`, `projectId` | as today |
| `recording.start`, `recording.importUrl`, import | `projectId` replaces `folderId` | as today |

Removed: `library.createFolder`, `renameFolder`, `updateFolderPersonality`, `setFolderNote`, `deleteFolder`, `folderSchema`, every `parentId`, every `colorKey` and `iconKey`.

**Selected project (critique 11).** There is no new channel: the existing `workspace.dispatch` (handled by `applyWorkspaceAction` in `library-handlers.ts`, lane L1) gets the action `publishSelectedProject` in place of `publishSelectedFolder`, and `WorkspaceState.selectedProjectId` replaces `selectedFolderId`. Semantics, which L4 and L5 both rely on: the renderer shell publishes the project id when the route is `/projects/<id>` and a project is resolved; it publishes `null` on every other route, including `/projects/none` and `/projects`; the shell tag for all three `/projects…` routes is `Projects`. `projects.delete` success publishes `null` from the handler. Consumers: `entry-points.ts` (tray and popup start the take in `state.selectedProjectId`, else no project), and `scope-resolver` (surface `Projects` with a non-null id gives scope `Project`; `/projects/none` and `/projects` give `AllMeetings`).

**Opening a thread (critique 19).** `chat.threads.open` answers `{ ok: true, state: ChatState, thread: { id, title, scope: ThreadScope, messages: ChatMessage[], scopeStatus: 'ok' | 'meeting-missing' | 'live-ended' } }` or `{ ok: false, reason: 'busy' | 'not-found' | 'corrupt' }` (busy: a send is in flight). The renderer rule: opening a thread sets the AiPanel scope to `thread.scope` and pins it; the pin holds until the user navigates to another page, chooses New chat, or picks a different scope. The existing scope-mismatch notice still explains when the page and the pinned thread differ. If `scopeStatus` is not `ok` (the meeting was deleted, or the thread came from a Live take that ended) the thread opens read-only: messages visible, composer disabled, one line says why ("The meeting for this chat was deleted"), and one action starts a new chat in the thread's project. `ChatService.send` refuses a thread in that state with `scope-gone`, so the rule holds even if the renderer is bypassed.

Security: the page never sees file system paths of project storage; file picking and path validation stay in main (same rule as chat attachments: absolute, local, regular file, no UNC or device paths, size and kind checked before reading). Project file text is untrusted data and is neutralized before it reaches a prompt (section 7). Every id in every input is a canonical lowercase GUID (zod), so a request cannot name a path.

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

Operate mode (impeccable): the visitor completes a task, so scanability, consistency and native expectations outrank expression. Whoever builds this loads `frontend-design`, `impeccable` and `accessibility`, runs `impeccable context` once, and reads `craft-floor.md` before the first edit. Strings in both locale files, UI lane only.

### 8.0 Impeccable conformance

The user asked that the whole tab follow the impeccable nomenclature and conventions. This table is the contract; the revision removed three items of the first draft that broke the craft floor (accent bar, modal editors, kicker-like group labels).

| Impeccable rule | How the Projects tab complies |
| --- | --- |
| Mode: Operate, restrained color, familiarity over invention | Standard affordances only: back link, tabs, list rows, menu, popover, confirm dialog from the existing kit. Tokens only (`paper`, `paper-raised`, `ink`, `ink-muted`, `ink-faint`, `hairline`, `border-control`); `signal` stays reserved for live recording |
| Refuse: same-size cards of icon + heading + text as the page structure | The page structure is header, tabs and a side panel. The grid exists because the product decision asks for project cards; each card carries real content (name, two-line description, last activity, meeting count, pin), no icon, no nesting, hairline border and no shadow |
| Refuse: kicker or eyebrow above a heading | None. "Pinned" and "All projects" are `h2` headings that own their grid; the page title is the only large text |
| Refuse: colored side border on cards | The 3 px accent bar of the first draft is gone, and so are `colorKey` / `iconKey` (decision 8). The `folder-*` color tokens leave `DESIGN.md` and `tokens.css` |
| "Modal as first thought" | Instructions and description edit inline in place; rename is inline; New project and Move to project open in a Popover anchored to their trigger. The single modal is the delete confirmation, where interruption is the point |
| Refuse: hero metric, section numbers, sparklines | Counts and dates are plain mono text (data, not decoration): IBM Plex Mono `tnum`, 12 px |
| Refuse: unicode or emoji as icons | One icon set (lucide through the kit `Icon`), one stroke weight; the Pin toggle is an icon button with `aria-pressed` and an accessible name |
| Type: fixed rem scale, tight ratio, display fonts out of labels | `text-heading` (20/28) for page and group titles, `text-ui-lg` 14 for rows, `caption` 12, mono 12; description line length capped near 65ch; no new sizes |
| Components: every interactive state, skeleton not spinner, empty states that teach | Default, hover, focus, active, disabled, loading and error exist for card, tab, row, menu, button and inputs (checked in L5 tests); skeleton cards and rows of the real layout; every empty state says what the thing is and the next action |
| Motion: 150 ms, state only, no page-load choreography | Menu, popover and panel expand use the kit's 150 ms ease-out; nothing animates on load; `prefers-reduced-motion` removes the rest |
| Overlays escape their container | Menus and popovers render through the kit portal, so the scrolling right panel never clips them |
| Responsive is structural | Two columns from 960 px; below it the right panel becomes disclosure sections under the header; the grid is `auto-fill, minmax(260px, 1fr)`; verified (section 9) |
| Copy: product voice, controls name their action, errors name problem and recovery | Sentence case, no exclamation marks, no emoji, no "AI magic"; the vocabulary below |
| Naming | Terms: Project, No project, Instructions, Context files, Meetings, Chats, Start meeting in this project, Move to project. UI keys follow the existing `Ui_<Area><Name>` pattern (`Ui_ProjectsTitle`, `Ui_ProjectStartMeeting`, `Ui_ProjectInstructionsEmpty`). Code: containers `*Route`, hooks `use-*`, one feature folder `features/projects`, shared list in `features/meeting-list` (section 8.4) |

The word "folder" survives in the UI only where it means a file-system folder (the Library location in Settings). Everything that meant a library folder says project. The shared-library notice `Ui_LibraryFolderShared` ("Both versions read and write the same files") is no longer true after the migration and is rewritten in this lane.

### 8.1 Sidebar

Rail: Record, Projects, Library, Settings. `/projects`, `/projects/<id>` and `/projects/none` keep Projects selected; Session keeps Library selected as today. Library becomes the flat "all meetings" list (search, filters, bulk, preview) with a project filter in place of the tree.

### 8.2 Projects grid (`/projects`)

```text
Projects                                              [ New project ]
[ Search projects      ]  Sort: Recent activity v
No project · 12 meetings                                          >
Pinned
┌──────────────────────┐ ┌──────────────────────┐
│ Universidad – Cálculo │ │ Producto Q4          │   card: name (the link), 2-line description,
│ Resumir en español…   │ │                      │   "14 Nov", meetings count in mono,
│ 14 Nov · 9 meetings   │ │                      │   pin toggle (IconButton, label required)
└──────────────────────┘ └──────────────────────┘
All projects
…
```

- Sort: Recent activity (default, `lastActivityAt`), Name (folded text), Newest (`createdAt`, descending). Pinned projects form a first group when any exist, sorted by the same key. Search filters name and description by folded text.
- A card is an `article` whose name is the `<a>`; the link's hit area is stretched over the card with a pseudo-element and the pin button sits above it, so there is no button inside a link. Tab order: name link, pin; Enter opens; visible focus ring on both.
- The "No project · N meetings" row appears only when N > 0, with its last activity date. It is a link to `/projects/none`.
- Empty (no projects and no unfiled meetings): one line, "A project keeps related meetings, instructions and files together.", and the New project button. Search with no result: one line with the query and a "Clear search" action. Loading: skeleton cards of the real layout.
- The migration notice (section 8.6) sits above the grid until dismissed.
- New project: a Popover anchored to the button with Name (required) and Description (optional). Inline errors for empty and name-taken, in words with an icon, no red; Enter submits, Escape closes. No color, icon or accent choice (decision 8).

### 8.3 Project page (`/projects/<id>`)

```text
‹ Projects
Universidad – Cálculo                [ Start meeting in this project ]   [ … ]
Weekly lecture notes and exam prep
 Meetings | Chats                                         │ Instructions                 [ Edit ]
 ───────────────────────────────────────────────          │ Resumir en español, con…
 search · filters                                         │
 2025-03-02  Clase 4 — Derivadas              52 min      │ Context files                [ Add ]
 2025-02-24  Clase 3 — Límites                48 min      │ Syllabus.pdf        PDF · 12 pages  x
 …                                                        │ notas.md            Text · 3 KB     x
```

- Header: name, description, one primary Button (`Start meeting in this project`, Mic icon), overflow Menu (Rename, Edit description, Pin, Delete). Rename and Edit description are inline: the text becomes an input in place, Enter or blur saves, Escape cancels, errors read "A project with this name already exists." in the same place. "‹ Projects" is a plain back link, not a breadcrumb chain.
- **Not found.** An id that is unknown, or a project deleted from another window (`projects.changed` removes it from the store while the page is open), shows the page frame with "Project not found", one line ("It may have been deleted."), and a "Back to projects" link. Nothing else renders, no tabs, no panel, and the published selected project is cleared.
- **Start meeting.** The button navigates to `/record?project=<id>&start=1`. RecordRoute reads both parameters once and immediately replaces the URL with `/record` (`replace: true`) before anything async runs, guarded by a ref so React strict mode cannot run it twice; a refresh therefore never starts a second take. Then:
  - project resolved in the store, nothing recording: set the destination and run the same ensure-ready and start flow as the Record button (setup checklist, model gates, mic checks keep working);
  - project id unknown (deleted meanwhile, or a stale link): destination falls back to No project, **no take is started**, and a Notice says "That project no longer exists. Choose where to save this meeting." (test: `/record?project=<unknown>&start=1`);
  - already recording: no second take, the active take's destination is not changed, the Record screen opens, and a toast says "A meeting is already recording" with its destination ("Saving to <project name>"); the Record screen shows the same destination as a quiet line while recording, so the user can verify it.
  Start does not depend on the rename or delete state of the header: renaming never changes the id, and delete is behind the confirm dialog, so the button is unreachable while it is open. If the project is deleted between click and start, `recording.start` falls back to no project in main (L4), never fails.
- Meetings tab: the shared meeting list (section 8.4) scoped to the project, newest first, with search, filters, row selection, bulk bar (Move to project, Delete) and preview. Empty: "No meetings in this project yet." plus the primary action nearby.
- Chats tab: persisted threads of this owner, newest first: title, last activity, scope badge, row menu Rename and Delete. The badge says Project, the meeting's title, or Live. A Meeting-scope thread whose meeting was deleted shows the badge "Meeting deleted" in ink-muted and still lists; opening it is read-only (section 6). "New chat" opens the AiPanel with Project scope. Clicking a thread opens it in the AiPanel (`chat.threads.open`, scope pinned). Empty: "No chats yet. Ask about this project's meetings."
- Right panel, fixed 320 px at 960 px and above; below that the two sections stack under the header as disclosure sections (native `details`/`summary` in a kit `Disclosure`, collapsed by default except Instructions when empty):
  - Instructions: read-only excerpt (first 6 lines, then "Show all") and Edit. Edit swaps the excerpt for a textarea in place with a live character counter against 20_000 (`aria-describedby`) and Save and Cancel; Ctrl+Enter saves, Escape cancels, a failed save keeps the text and shows the reason. Empty: "Tell Vozella how to summarize and answer for this project."
  - Context files: Add (picker), list of name, kind, size or pages, Remove (IconButton named with the file name). Adding shows a row with a skeleton line and "Reading…", errors per row in words ("Encrypted PDF", "Duplicate", "Too large (max 20 MB)", "Limit of 25 files reached", "No text found", "Not supported"). One quiet line: "Files are copied into this project and the relevant parts are used when you chat, ask live or summarize."
- Delete: confirm dialog naming the meeting count: "Delete project? Its 12 meetings move to No project. Instructions, files and chats of this project are deleted." The primary confirm is a normal Button (no danger variant in the kit). A `partial` failure keeps the project and says "Moved 9 of 12 meetings. Try again." with a Retry action; `busy` says a meeting is still recording or processing.

### 8.4 No project (`/projects/none`) and the shared meeting list

Same frame without the right panel and without Start meeting, title "No project", subtitle "Meetings that are not in a project". Tabs: Meetings (rows have "Move to project" in the row menu; the bulk bar has it too) and Chats (threads with no owner). Empty: "Every meeting is in a project." Move to project opens a Popover with a searchable flat list (kit Autocomplete, single-select, Enter confirms) of all projects plus "No project" when invoked from inside a project. After moving, an undo offer appears (existing UndoOffer). The same popover is used from the Library list, the meeting preview and the session header. A failure `storage-*` says projects are unavailable right now and why.

Shared list (critique 13). The Library and the project pages render the same meeting list, bulk bar, preview and filters. Rule: the list becomes its own feature module, `apps/desktop/src/renderer/features/meeting-list/` (extracted by L5 from `features/library`: `MeetingGrid`, `BulkBar`, `ListHeader`, `use-bulk-actions`, the list store renamed `meeting-list-store`, the filters and the preview). Dependency direction: `features/library` and `features/projects` import from `features/meeting-list` and from `ui/`, `app/`, `i18n/`; features never import each other. A unit test scans imports and fails on `features/projects → features/library` (and the reverse). The Library route is then the flat all-meetings screen built from that module plus the project filter. Library project filter: All projects, No project, or one project; when the chosen filter has no meetings: "No meetings in <project>." with "Clear filter"; for No project: "Every meeting is in a project."

### 8.5 Record destination and chat panel

The destination select on Record lists "No project" first, then pinned projects, then the rest by name (flat, no "Parent / Child" paths). "Start meeting in this project" preselects it. The tray and popup entry points use the selected project (the shell publishes it while the project page is open, section 6).

AiPanel header gets a History control: a popover list of threads for the current owner (project or no project), New chat, open, rename, delete. Opening a thread from anywhere pins its scope under the rule in section 6.

### 8.6 States of the tab

| State | What the user sees |
| --- | --- |
| `projects.list` loading | skeleton cards (grid), skeleton rows (page) |
| storage `migrating` | the grid area shows "Preparing your projects…" with skeleton cards; project writes are disabled |
| storage `error` | Notice: "Projects could not be loaded. Your meetings are not affected. Restart Vozella to try again." plus the message; project actions disabled; meetings list as No project |
| storage `newer` | Notice: "This library was created by a newer version of Vozella. Update to use projects. Your meetings are still available."; project actions disabled |
| migration notice, normal | "7 folders became projects. 2 were renamed to avoid duplicates." with the renamed list on demand and a Dismiss button; shown once |
| migration notice with `skipped` | adds "3 folders could not be converted because their ids were invalid or repeated. Their meetings are under No project. The original list is saved in the backups folder of your library." |
| migration notice with `legacyLeftovers` | adds "Meetings from an older layout were found in <location> and were not imported." (location named in words, never a raw path) |
| a project skipped as `corrupt`, `unsupported` or `unsafe-dir` | a quiet line under the grid: "1 project could not be read. Its meetings are under No project." |
| project page, unknown id | "Project not found" (section 8.3) |

### 8.7 Copy rules

"Project", "No project" / "Sin proyecto", "Move to project" / "Mover a proyecto", "Instructions" / "Instrucciones", "Context files" / "Archivos de contexto". Existing values that say folder, carpeta or Inbox in the library sense are reworded; key names that core code references keep their names. Both locale files in the same commit, parity test green; Spanish is natural Latin American Spanish, sentence case.

## 9. Test strategy

- Unit (Vitest, every package): pure logic first, RED before GREEN where a deterministic test exists: name resolution, plan building (duplicate ids, cycles, odd ids), directory allocation and validation, project service, context packer, thread lifecycle, sort and search ordering, navigation helpers, the version rule (`max(per-kind) <= STORAGE_SCHEMA_VERSION`). The Contracts phase includes tests for the zod schemas and the shared kernel.
- Integration (Vitest with real fs): adapters run on `fs.mkdtemp` directories under the OS temp folder. The migration runs against a committed legacy fixture library written in plain JSON by hand (BOM, CRLF, nesting, collisions, orphans, 5 meetings). Crash and resume by injecting a failing writer; backup hash equality; idempotency by running twice and comparing a directory snapshot; read-only mode by pausing the migration and calling every writer; ordering by asserting that no getter resolves before `migrateStorage` and that a meeting save started during the migration waits; library location change with two temp roots. Every run sets `VOZELLA_DATA_ROOT` to a temp folder; the data-root guard refuses the real data folders. No real accounts, no model downloads.
- Contract: each new channel round-trips input and output through its zod schema; main handlers are tested with fakes.
- Component (jsdom): grid, page, inline editors, popovers, thread list, move popover; keyboard behavior and accessible names; the 960 px layout through a mocked `matchMedia` (`(min-width: 960px)` drives a `data-layout="side" | "stacked"` attribute that the test asserts, plus the disclosure open and closed state).
- E2E (Playwright `_electron`, one spec `projects.spec.ts`, scenarios in section 13.5): run with `VOZELLA_E2E_BACKGROUND=1` so no window pops up; includes a real resize across 960 px. `pnpm check` (typecheck, lint, unit) passes before every commit.
- Not verifiable here: real Windows Recycle Bin behavior, real PDF files from the wild, long libraries (> 5k meetings) with many projects, a real picked Library folder; these stay as manual checks.

Required cases by risk (each is named in the lane that owns it): duplicate folder ids; id differing only by case; parent cycle and self-parent; depth above the cap; odd ids (path separators, `..`, device names); corrupt `dir` (absolute, `..`, `.vozella`, reserved name); allocation avoiding existing on-disk directories, accents and case, reserved names, trailing dots, prefix and child of a migrated dir; legacy `<appData>/folders.json` adopted and backed up; backup missing, unreadable or different aborts with nothing written; source delete failure keeps manifest v1 with no rerun and no second backup; writers refused while migrating or in error; meeting save during `error` moves nothing; unknown per-kind version listed as `unsupported` and write refused; unknown keys survive read-modify-write for every file kind; delete resumable after a crash between moves, partial result counts, parent delete never touching a child's meetings; duplicate meeting id tie-break and shadowed audio untouched.

## 10. Removal list

Nesting (all of it):

- core: `library/folder-tree.ts` (`folderChain`, `folderDirectorySegments`, `buildFolderTree`, `flattenFolderPaths`, `buildBreadcrumbs`, `expandedAncestors`; the locale collator moves next to the project sort), `FolderRecord` and `folder.ts`, `folder-personality.ts` (accent and icon), `nameTaken` parent-scoped logic and the B26b orphan rule in `library-service.ts`, `canDeleteFolder` and the `not-empty` failure, `createFolder({parentId})`.
- renderer: `LibraryFolders.tsx`, `Breadcrumbs.tsx`, `ui/Tree.tsx`, `ui/tree-navigation.ts` and their tests and gallery entries, folder tree keyboard navigation, create-inside-current-folder, `expandedAncestors` in `library-store.ts`, `use-folder-note.ts` (instructions replace it), `folder-visuals` and its test, parent pickers in dialogs, the `folder-*` color tokens.
- contracts: `folderSchema`, `parentId`, `colorKey`, `iconKey`, the five folder channels.
## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Migration corrupts or loses folder data | High | Pure plan first, no write before a hash-verified backup; ids kept; no meeting file moved; source deleted only after the manifest; idempotent and resumable; fixture tests including a crash; malformed input (duplicate ids, cycles, odd ids) is deduped or skipped and reported, never guessed |
| Folder list left at the app data root is never found | High | Step 001 reads the Library root first and the app data root second; leftovers of older layouts are detected and reported; test for the app data case |
| Writes during or after a failed migration clobber the frozen dirs | High | Read-only mode until the manifest exists; services published only after `migrateStorage`; ordering test |
| A hand-edited `dir` aims a write or delete outside the Library | High | Schema and `isSafeProjectDir` at parse, `isUnder` at use, no operation ever discards a project dir, writes refused for a skipped project |
| A user opens the library with an older app after migrating | Medium | Backup stays in `.vozella/backups`; the older app finds no folder list and shows everything as Inbox; forward-only by design, stated in the notice |
| Newer library opened by an older Vozella, or a newer file kind in an older library | Medium | Manifest refusal, plus the rule that no per-kind bump ships without a manifest bump, plus `unsupported` files that block writes and keep their name and dir reserved, plus unknown keys preserved |
| Duplicate meeting copies hide each other | Medium | Deterministic winner, shadowed copy reported and never deleted or rewritten, shared audio protected |
| Prompt grows past the local model window | High for local users | Fixed small local budgets, project block carved out of the meeting budget, local prompt-budget tests |
| BM25 over large files is slow on every ask | Medium | Caps (25 files, 1M chars), mtime cache, pre-chunking as a v2 upgrade if measured; Live asks use small budgets |
| Prompt injection through project files or instructions | Medium | Existing neutralization of structural lines, labelled blocks, files presented as data, instructions as the user's guidance; same trust model as meeting text |
| Scanner picks up Markdown in project files | Medium | Project files live under `.vozella`, which the scanner skips; test with a `.md` context file |
| Large field rename (`folderId` to `projectId`, about 150 files with tests and e2e) breaks lanes | Medium | Done once, mechanically, typecheck-driven, in the Contracts phase before any lane branches; the on-disk key is unchanged; `suggestedFolderId` excluded |
| Writing meetings and settings plain (LF, ISO ms) surprises old tooling | Low | Readers keep accepting the old shapes; round-trip tests on CRLF and seven-digit files; flagged as decision 9 |
| Frozen `dir` confuses users who look in Explorer | Low | Documented trade-off; new projects get readable names; revisit with a future "reveal folder" action |
| Deleting a project with chats loses history | Medium | Confirmation text states it; the project's storage goes to the Recycle Bin; delete is resumable and reports partial failure |
| Concurrent writes (rename while adding a file) | Low | Per-project keyed mutex; every file written atomically; meta.json written last |
| Single UI lane is the largest | Medium | UI sections are independent (grid, page, no-project, meeting-list extraction, chat history, record); the lane commits per section |

## 12. Decisions and the answer to the critique

### 12.1 Decisions made in this design

These follow from the approved product decisions and from the user's instruction on 2026-11-16 that the tab follow the impeccable nomenclature.

1. The Library route stays as the flat all-meetings list (cross-project search, filters, bulk). Projects is a new rail entry; the folder tree is gone.
2. Project directories are frozen at creation; migrated projects keep their existing directories, so the migration moves no files.
3. The three earlier startup migrations are removed together with the folder code. Step 001 itself finds the folder list in the Library root or, failing that, the app data root; older layouts are detected and reported, not imported.
4. `folderId` becomes `projectId` in code, IPC and domain; the frontmatter key is the only place that keeps the old name.
5. Threads are persisted for every chat scope and owned by a project or by no project; a thread is created on its first successful turn.
6. Dates in the new storage are ISO-8601 UTC. Meeting frontmatter dates are written ISO-8601 with offset and millisecond precision; readers accept the older seven-digit form.
7. Project files are copied, extracted once, never re-read from the original path, and images are out for v1.
8. Projects have no accent color or icon. The first draft carried `colorKey` and `iconKey` as migrated data with a 3 px accent bar; that bar breaks the impeccable ban on colored side borders, and keeping data nothing can display or edit is dead weight. The old values stay in the backup.
9. Meeting Markdown and `settings.json` are written plain (UTF-8, LF, no escaping) and read tolerantly (BOM, CRLF, any key case, numeric strings), so no file the user already has becomes unreadable. If the user wants the tolerant readers gone too, that orphans files written by earlier versions and needs a separate decision.
11. No Rust is added. The addon stays as the stack says: only where the OS forces it.

### 12.2 Critique points

Verdict key: accepted, accepted with change, rejected in part.

| # | Verdict | What changed and where |
| --- | --- | --- |
| 1 | Accepted with change | Chose the second fix: step 001 reads `<Library>/folders.json` then `<appData>/folders.json` and reports older layouts (4.5, step 1). Rejected keeping `migrateUserDataLocation` and `migrateLibraryLayout` as frozen steps before 001: that keeps earlier startup code the design removes, and the flat dump is already found by the recursive scan. The deliberate drop is decision 3 and a parity row; L1 tests the app data case |
| 2 | Accepted | Ids validated with `parseGuid` and lowercased; duplicates deduped before any write; cycles, self-parents and depth above 32 become roots; odd and invalid ids skipped and reported; tests listed (4.5 step 2, section 9). Chose dedupe over failing the step, so one bad entry cannot block every project |
| 3 | Accepted with change | `dir` validated in the schema and again with `isUnder` (4.3). Rejected "fall back to Inbox" for writes: it would silently move a project's meeting to Inbox. Reads answer Inbox, writes are refused and the project is reported as `unsafe-dir` |
| 4 | Accepted | Allocation rules in 4.3: folded comparison, on-disk entries, legacy dirs, reserved names, trailing dots and spaces, prefix and child of a frozen dir, `mkdir` reservation. Tests in L1 |
| 5 | Accepted | `StorageState` and read-only mode, `build()` publishes after `migrateStorage`, ordering test (4.4, section 9). Added: meetings never relocate while the state is not ready |
| 6 | Accepted | The manifest-bump rule, `unsupported` files that block writes, loose schemas that keep unknown keys, a test for each (4.2) |
| 7 | Accepted | `sha256` re-read verification, backup never pruned, missing backup aborts with nothing written, delete failure leaves manifest v1 with no rerun and no second backup, a verified identical backup is reused (4.5 steps 5 and 7) |
| 8 | Accepted | Delete is idempotent and resumable, returns `partial {moved, remaining}`, and never discards a project dir, only `.vozella/projects/<id>`; crash and parent-with-child tests (section 5) |
| 9 | Accepted | Deterministic tie-break (mtime, then path), shadowed copy reported in `library.load` and never deleted or rewritten, shared audio protected; location change runs `migrateStorage` on the new root with an integration test (4.4, 4.6) |
| 10 | Accepted | Section 13.3 states that no lane branches before the Contracts commit merges and that L1 may rewrite the Contracts-renamed files freely |
| 11 | Accepted | No new channel: `workspace.dispatch` action `publishSelectedProject`, handler in `library-handlers.ts` (L1), semantics for `/projects/<id>`, `/projects/none` and elsewhere in section 6 |
| 12 | Accepted with change | The listed files join the Contracts rename list (13.1), with the `suggestedFolderId` exclusion. Platform summaries tests also belong to L3 afterwards because L3 changes the service dependencies they construct, so ownership passes from Contracts to L3 once Contracts merges |
| 13 | Accepted | New `features/meeting-list` extracted by L5, dependency rule and a boundary test (8.4) |
| 14 | Accepted | `projects.list` returns `noProject {meetingCount, lastActivityAt}` and `storage` (section 6) |
| 15 | Accepted (drop option) | No color or icon in the model, dialog, menu or card; the swatch picker was rejected because it adds a color-only control the craft floor argues against (decision 8) |
| 16 | Accepted | (a) not-found state, (b) notice copy for skipped, leftovers and unreadable projects, (c) "Meeting deleted" badge and read-only open, (d) Newest is `createdAt`, (e) empty states for the Library filter (8.3, 8.4, 8.6) |
| 17 | Accepted | jsdom test with mocked `matchMedia` and a Playwright resize across 960 px (section 9, e2e scenario 11) |
| 18 | Accepted | Mid-take toast and destination line, no autostart for an unknown project, URL parameters consumed with `replace`, strict-mode guard, tests (8.3) |
| 19 | Accepted | `chat.threads.open` returns the full `ThreadScope`, messages and `scopeStatus`; the pin rule and the read-only behavior for a missing meeting are in section 6 and in the Contracts schema notes |

## 13. Implementation plan

Phases: Contracts (serial), five lanes in parallel (each in its own worktree on a branch from the Contracts commit), integration, multi-lens review with one fix round, e2e. Commits are conventional, tests and docs with behavior, no attribution, no push. Every lane loads the skills its surfaces require from `.atl/skill-registry.md` before editing (`design-patterns` everywhere; `electron-best-practices` for main and IPC; `vitest` for tests; `frontend-design`, `impeccable`, `accessibility` for the UI lane; `playwright-best-practices` for e2e).

### 13.1 Contracts phase

CONTRACTS PHASE (serial, one writer, before any lane). Output must leave `pnpm check` green with the app still compiling; every lane file named below exists as a compile-clean stub or final code. Lanes may not touch anything this phase owns (list at the end).

1. Vocabulary rename (mechanical, typecheck-driven, includes tests): `MeetingRecord.folderId` and `MeetingListItem.folderId` become `projectId` (`packages/core/src/library/meeting.ts` and every user); `ChatScopeKind` `'Folder'` becomes `'Project'`; `ChatScopeDecision`/`ThreadScope` `folderId` becomes `projectId`; `WorkspaceState.selectedFolderId` becomes `selectedProjectId` and `Workspace.publishSelectedFolder` becomes `publishSelectedProject`; the workspace action `'publishSelectedFolder'` becomes `'publishSelectedProject'` with `{ projectId }`; recording start/import inputs `folderId` becomes `projectId`; `ShellTag` gains `'Projects'` (`SHELL_TAGS` in core; `tagOfPath` and `routeOfTag` stay in the renderer lane). The persisted meeting frontmatter KEY stays `"folderId"`: `meeting-markdown.ts` maps key `folderId` to field `projectId` in exactly two places (parse and render), with a comment that it is the on-disk name of the project id. **Exclusions:** the Jev analysis fields `suggestedFolderId` and `folderConfidence` are NOT renamed (stored data; a blanket search and replace must skip them). Core i18n keys containing "Folder" (`ChatFolderNotFound`, `ChatFolderNotSelected`, `ChatNoMeetingsInFolder`, …) keep their names; only their values are reworded later by the UI lane.
   **Files outside every lane that carry `folderId` and are renamed here** (critique 12), besides whatever the typechecker finds: `packages/core/src/transcription/retranscription.ts` and its test, `packages/core/src/session/session.test.ts`, `packages/platform/src/audio/recover-recordings.test.ts`, `packages/platform/src/fs/atomic-write.test.ts` and `keyed-mutex.ts` (comment), `apps/desktop/src/main/transcription/transcription-controller.test.ts` and `.cloud.test.ts`, `apps/desktop/src/main/ipc/session-handlers.test.ts`, and the e2e files under `apps/desktop/e2e` that the typechecker includes (mechanical rename only; the e2e phase rewrites the folder-tree specs). Files that sit inside a lane's globs (for example `packages/platform/src/summaries/*.test.ts` in L3) are renamed here too; ownership then passes to that lane when Contracts merges.

2. `packages/core/src/projects/` (new module, `index.ts` exports all):
   - `project.ts`: `PROJECT_NAME_MAX=120`, `PROJECT_DESCRIPTION_MAX=500`, `PROJECT_INSTRUCTIONS_MAX=20_000`, `MAX_CHAIN_DEPTH=32`; `Project` (no color or icon); `ProjectListItem = Omit<Project,'instructions'> & {meetingCount, fileCount, lastActivityAt}`; `ProjectsOverview {projects, noProject: {meetingCount, lastActivityAt|null}}`; `NewProject {name, description?}`; `ProjectPatch {name?, description?, instructions?, pinned?}`; `SkippedProject {id|null, dir|null, reason: 'corrupt'|'unsupported'|'unsafe-dir'}`.
   - `project-file.ts`: `ProjectFile`; `PROJECT_FILE_MAX_FILES=25`; `PROJECT_FILES_MAX_TOTAL_CHARS=1_000_000`; `AddProjectFileResult` and `ProjectFileFailure` ('not-found'|'unsupported'|'too-large'|'encrypted'|'no-text'|'unreadable'|'duplicate'|'project-full'|'not-a-project'|'storage-migrating'|'storage-error'|'storage-newer'; images are 'unsupported'). Reuses `ATTACHMENT_MAX_BYTES`, `ATTACHMENT_MAX_CHARS`, `attachmentKindForName` from core/chat/attachments.
   - `errors.ts`: `StorageTooNewError(found, supported)`, `ProjectFileCorruptError(path, reason)`.
   - `ports.ts`: `Result<T>`, `ProjectFailure`, `StorageState`, `ProjectRepository`, `ProjectFileStore`, `ProjectContextSource`, `MeetingPlacement` (signatures in section 5 of `docs/design/projects.md`). `ChatThreadRepository` lives in `chat-thread.ts`.
   - `storage-layout.ts`: pure `createStorageLayout(libraryRoot, path: PathJoiner)` with constants `META_DIR_NAME='.vozella'`, `INBOX_DIR_NAME='Inbox'`, `STORAGE_SCHEMA_VERSION=1` and the path functions of section 4.1 (`manifestFile`, `backupsDirectory`, `projectsDirectory`, `projectDirectory(id)`, `projectJsonFile(id)`, `filesDirectory(id)`, `fileDirectory(id,fileId)`, `chatsDirectory(owner)`, `threadFile(owner,id)`, `inboxDirectory`). Every id argument is asserted to be a canonical lowercase GUID (throws otherwise), so a layout function can never build a path from untrusted text.
   - `project-context.ts` (FINAL implementation and tests, shared kernel): `ProjectContextBudget {instructionsChars, filesChars}`; `projectBudgetFor(surface:'chat'|'live'|'summary', providerId)` with the budgets of section 7; `packProjectContext({name, instructions, documents, budget, query}): string|null` (instructions neutralized and capped with `cutPrefix`; files through `packAttachments(documents, budget.filesChars, query)`; labels `PROJECT_INSTRUCTIONS_LABEL` and `PROJECT_FILES_LABEL` exported; null when there is neither).
   - `in-memory-projects.ts`: `InMemoryProjectRepository`, `InMemoryProjectFileStore`, `InMemoryChatThreadRepository`, `InMemoryProjectContextSource` fakes for every lane's tests, with a settable `StorageState` so the read-only paths are testable.
   - `project-service.ts`: stub class `ProjectService` with the final public signatures (`list`, `get`, `create`, `update`, `setInstructions`, `delete` returning the `partial` result, plus the helpers the controller needs); bodies throw 'not implemented' (replaced by L1).
3. `packages/core/src/chat/chat-thread.ts` (final types, stub-free): `ThreadOwner`, `ThreadScope`, `ChatThread`, `ChatThreadSummary {id,ownerProjectId,scope,title,updatedAt,messageCount}`, `ChatThreadRepository` (section 5), `ThreadScopeStatus = 'ok'|'meeting-missing'|'live-ended'`. `ChatService` and `scope-resolver` behavior is NOT changed here beyond the rename. Shared kernel edit in `packages/core/src/chat/context-packer.ts` (final, with tests, then owned by L2): `LiveContextSnapshot` gains `projectId?: string|null` and `project?: string|null` (a pre-packed project block); `packLiveSession(live, budget, projectBlock?: string|null)` places the block after the title/notes lines and before the digest; the Live case of `packContext` forwards `snapshot.project`. `apps/desktop/src/main/recording/live-ask-handlers.ts` `LiveChatContext` gains `projectId: string|null` (null until L4 fills it).
4. `packages/contracts/src` (zod only, no runtime deps beyond zod):
   - `projects.ts`: `projectSchema`, `projectListItemSchema`, `projectFileSchema`, `storageStateSchema`, `projectFailureReasonSchema` (the `ProjectFailure` enum), `projectDeleteResultSchema` (done | failure | `partial {moved, remaining}`), `projectFileFailureSchema`, and the channels of section 6 (`projects.list` with `noProject` and `storage`, `projects.get`, `projects.create`, `projects.update`, `projects.setInstructions`, `projects.delete`, `projects.files.pick`, `projects.files.add`, `projects.files.remove`, `projects.migrationReport`, `projects.dismissMigrationReport`, event `projects.changed`). Every id field is a canonical lowercase GUID schema (lowercased on parse).
   - `chat.ts` additions: `chatScopeKindSchema` `'Folder'` becomes `'Project'` and `projectId` in `chatScopeSchema`; `threadScopeSchema`, `chatThreadSummarySchema`; `chatStateSchema` gains `threadId` (string|null) and `historySaved` (boolean); channels `chat.threads.list`, `chat.threads.open` (output as in section 6 "Opening a thread": `ok, state, thread {id, title, scope, messages, scopeStatus}` or `reason: busy|not-found|corrupt`), `chat.threads.rename`, `chat.threads.delete`, event `chat.threads.changed`; `chat.send` failure gains `scope-gone`.
   - `library.ts`: remove `folderSchema`/`FolderDto` and the five folder channels; `library.load` output drops folders and gains `shadowed`; `meetingListItemSchema`/`meetingRecordSchema` `folderId` becomes `projectId`; `libraryMoveMeeting(s)` take `projectId` and can fail `storage-*`; `librarySearch` scope `{kind:'all'|'none'|'project', id}`; `libraryChanged` reason enum `'meeting'|'project'|'location'`; `shellTagSchema` gains `'Projects'`; workspace state `selectedProjectId` and action `publishSelectedProject`.
   - `recording.ts`: start/importUrl/import inputs `projectId`.
   - `storage.ts` (persisted formats, validated by platform adapters): `libraryManifestSchema`, `projectRecordSchema` (project.json, with `projectDirSchema` of section 4.3), `projectFileMetaSchema`, `extractedTextSchema`, `chatThreadFileSchema`. Every schema is a loose object (`z.looseObject`) with `schemaVersion: z.literal(1)` as discriminator so v2 can be added as a union member with an upgrade function.
   - `channels.ts` / `index.ts` / `wire.ts` register all new channels; contract tests (zod round trip, strict inputs, lowercase GUID normalization, unsafe `dir` rejected, unknown keys kept) for each new schema.
5. `packages/platform/src/projects/` and chat stubs with FINAL factory signatures (stub bodies return the in-memory fakes; each lane replaces its own body, keeping the signature): `project-repository.ts` `createProjectRepository({libraryRoot, logger, clock, newId, state, discard?})` [L1]; `project-file-store.ts` `createProjectFileStore({layout, extractor, state, logger, clock, newId})` [L3]; `project-context-source.ts` `createProjectContextSource({projects, files})` [L3]; `packages/platform/src/chat/chat-thread-store.ts` `createChatThreadStore({layout, state, logger, clock, discard?})` [L2]; `storage-migrator.ts` `migrateStorage(ctx): Promise<StorageState>` with an empty `MIGRATIONS` registry, and `storage-state.ts` (the shared mutable holder) [L1].
6. `packages/platform/src/library/library-runtime.ts` (L1 owns the file after this phase): getters `projects`, `projectService`, `projectFiles`, `chatThreads`, `projectContext` built in `build()` from the factories above; `LibraryRuntimeDeps` gains `extractor: DocumentExtractor`; `LibraryChangeReason = 'meeting'|'project'|'location'`. `packages/platform/src/index.ts` exports every new platform file once (the barrel then belongs to L1, which only removes deleted exports).
7. `apps/desktop/src/main` (Contracts owns until the end of the project): `index.ts` passes the shared threaded extractor to `LibraryRuntime` and `projectContext`/threads to `composeChat`, `composeSummaries`, `composeRecording` (their Deps interfaces gain those fields, minimal edit); new `main/projects/compose-projects.ts` registers `registerProjectHandlers` (L1 file), `registerProjectFileHandlers` (L3 file), both stubbed; `ipc/handlers.ts` and `compose-test-kit.ts` updated. Lanes never edit `index.ts`, `ipc/handlers.ts`, `compose-projects.ts` or `compose-test-kit.ts`.
8. Tests: contracts schema tests, `project-context.ts` unit tests (budgets, neutralization, query ranking, null cases, local budget carve-out), `storage-layout` tests (GUID assertion included), in-memory fakes smoke tests, the version-rule test (`max(per-kind) <= STORAGE_SCHEMA_VERSION`). No UI, no locale changes.

OWNED BY CONTRACTS (lanes must not edit): `packages/contracts/src/**`, `packages/core/src/index.ts`, `packages/core/src/projects/**` except the files owned by L1 (`project-service*.ts`, `project-names*.ts`, `project-dir*.ts`), `packages/core/src/chat/chat-thread.ts` (until L2 starts), `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc/handlers.ts`, `apps/desktop/src/main/projects/compose-projects.ts`, `apps/desktop/src/main/compose-test-kit.ts`, `apps/desktop/e2e/**` (until the e2e phase), and every file in the rename list above that no lane owns. If a lane needs a contract change it stops and asks for a contract patch commit; it never edits those files.

NEW LOCALE KEYS: backend lanes add none. Failure reasons are enums; the UI lane maps them to strings. Existing core string keys keep their names.

### 13.2 Lanes

Rules for every lane: edit only the exclusive surfaces below (no file appears in two lanes; verified mechanically against `git ls-files`); tests sit next to the code; no new barrel exports (public symbols go in files the Contracts phase created); no locale edits outside the UI lane; no edits to Contracts-owned files; `pnpm check` green before each commit; test first.

### `L1-storage` Storage, migration and project use cases

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/library/**`
- `packages/core/src/projects/project-service*.ts`
- `packages/core/src/projects/project-names*.ts`
- `packages/core/src/projects/project-dir*.ts`
- `packages/platform/src/library/**`
- `packages/platform/src/projects/project-repository*.ts`
- `packages/platform/src/projects/storage-migrator*.ts`
- `packages/platform/src/projects/storage-state*.ts`
- `packages/platform/src/projects/migrations/**`
- `packages/platform/src/index.ts`
- `apps/desktop/src/main/ipc/library-handlers*.ts`
- `apps/desktop/src/main/ipc/projects-handlers*.ts`
- `apps/desktop/src/main/projects/projects-controller*.ts`

Goal: Replace the folder tree with flat projects on disk, migrate old libraries safely, expose the project use cases, and remove the folder code from the library domain. Read sections 3, 4, 5, 6 and 10 of docs/design/projects.md.

Build:
- core/projects: `project-names` (pure: validate name, fold for uniqueness with `foldText`, `planProjects` with duplicate-id dedupe, cycle and depth-cap handling, invalid-id skip, `resolveMigratedNames` for the collision rule of 4.5), `project-dir` (`isSafeProjectDir`, `sanitizeDirName`, `allocateProjectDir(name, taken)` per 4.3), `ProjectService` (create, update, setInstructions, delete with the resumable `partial` contract of section 5, list with `lastActivityAt` from ProjectRepository + MeetingRepository + ChatThreadRepository.activity + ProjectFileStore counts and the no-project overview, pin, name-taken with folded names, busy checks).
- core/library: `LibraryService` keeps load, search, moveMeeting(s), deleteMeeting(s) and loses every folder use case; `LibraryView` becomes all | none | project(id); remove nesting and the folder code per section 10 (`folder.ts`, `folder-tree.ts`, `folders-json.ts`, `folder-personality.ts`, `canDeleteFolder`, `FolderRepository`, `nameTaken` parent logic, reserved Meetings/Recordings rule, legacy app-paths fields, `chatThreadsFilePath`); the old JSON helper module is deleted with `parseGuid` and `stripBom` moved (names kept) to `guid.ts` and `text-bom.ts`; `settings.ts` and `meeting-markdown.ts` write plain UTF-8/LF/ISO-8601 ms and keep tolerant readers; `in-memory-library` and `workspace` follow the rename (`selectedProjectId`, `publishSelectedProject`, shell tag Projects).
- platform/projects: `FileProjectRepository` (`project.json` per project, atomic writes, per-project keyed mutex, loose zod validation with `schemaVersion`, frozen dir allocation with `mkdir` reservation, `directoryOf` with the schema and `isUnder` checks, unsupported and corrupt reporting, writes refused unless the state is ready, delete = `discard()` of `.vozella/projects/<id>` only); `storage-state` holder; `storage-migrator` (manifest read and write, `MIGRATIONS` registry, newer-than-supported refusal, per-step manifest commit, the leftover-source cleanup of 4.5 step 7); `migrations/001-folders-to-projects.ts` and `migrations/legacy-folders-reader.ts` exactly per 4.5 (source discovery in Library then app data, plan, hash-verified backup with reuse, project writes, manifest, source delete).
- platform/library: `MarkdownMeetingRepository` takes a `MeetingPlacement` instead of folders, keeps a meeting in place when `directoryOf` is null, scans skipping dot-directories, resolves duplicate ids deterministically and reports `shadowed`, protects audio referenced by a shadowed copy, drops the legacy flat-dump logic (`isLegacyFlatDump`, `isUserFolderDirectory`, `locate`, `legacy` in `prefer`); `library-runtime.build()` constructs services into locals, runs `migrateStorage`, then publishes (4.4), wires `ProjectService` and the new getters, rebuilds on `setLocation` (migration on the new root); delete `json-folder-repository.ts`, the three legacy migrations in `migrations.ts`, the old library layout test and its fixtures; `ensure-directories` creates Inbox and `.vozella` only; `library-layout` loses `directoryFor`/`folderDirectorySegments` use; the `json-settings-store` follows the plain writer.
- main: `library-handlers` lose folder channels, `library.load` returns meetings, skipped and shadowed, search takes the new scope, `applyWorkspaceAction` handles `publishSelectedProject` (section 6); `projects-handlers` and `projects-controller` serve `projects.list/get/create/update/setInstructions/delete/migrationReport/dismissMigrationReport` and broadcast `projects.changed` and `library.changed('project')`; `projects.delete` success publishes `null` as selected project. Controllers take the dialogs and `discard` (Electron `shell.trashItem`) as injected deps.

Tests this lane adds:

Vitest, test first. Unit: `project-names` and `planProjects` (sibling-unique parents, deep chains, case and accent collisions, existing root named like the prefixed result, numeric suffix order by createdAt then id, orphan parentId as root, duplicate ids incl. case-only differences, A->B->A and self-parent cycles, depth above 32, invalid and odd ids such as separators, `..`, device names, empty and over-long names), `project-dir` (sanitize, reserved names, trailing dot and space, fold equality, taken by existing directories, legacy `Meetings`/`Recordings`, prefix and child of a nested frozen dir, suffix order), `ProjectService` (name-taken folded, empty, too long, delete refuses while busy, partial result with moved and remaining, re-run finishes, crash between moves, parent delete leaves a child's meetings and dir alone, lastActivityAt, pin), library-view, library-service moves. Platform integration with a temp `VOZELLA_DATA_ROOT` (mkdtemp, never real Documents): `FileProjectRepository` (atomic write, corrupt and newer-version project.json reported not skipped, unknown keys survive read-modify-write, unsafe dir rejected in schema and at use, dir allocation on a populated Library root, directoryOf unknown id = Inbox and null while not ready, writes refused in migrating, error and newer, concurrent updates serialized), `storage-migrator` (fresh install creates manifest v1 and no backup; newer manifest throws `StorageTooNewError` and writes nothing; a step failure leaves the manifest unchanged and the state `error`; registry bump rule), `001-folders-to-projects` against a fixture legacy library (BOM, CRLF, PascalCase and camelCase keys, 3-level nesting, sibling-unique and globally colliding names, orphan parent, note to instructions, ids preserved, dirs frozen to the old chain so zero files move, backup byte-identical and hash-verified and created before any project.json, backup missing or unreadable or different aborts with nothing written, reuse of an identical earlier backup, folders.json removed only after the manifest, delete failure with EBUSY keeps manifest v1 with no rerun and no second backup and retries the delete next launch only when the hash matches, second run is a no-op, resume after a crash injected after N projects, corrupt source leaves no manifest and reports the error, source in the app data root adopted and backed up, Library root source wins and the other is only reported, older layouts reported as leftovers, meetings with unknown folderId read as no project), `LibraryRuntime` (no getter resolves before the migration, a meeting save started during it waits, location change to a second temp root migrates that root and swaps the services, meeting save while the state is error moves nothing), `MarkdownMeetingRepository` (project directory placement, move between projects moves md+wav+mic activity and rewrites audioFilePath, dot-directories ignored, duplicate id picks newest mtime then path and reports shadowed, shadowed copy and its audioFilePath untouched by a move or delete, shared audio kept), round trips of CRLF, BOM and seven-digit-offset files through the plain writers. Controllers and handlers: ipc tests with fakes, including `publishSelectedProject`. Contract: every channel input and output round-trips its zod schema.

### `L2-chat-threads` Chat persistence and project-aware chat context

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/chat/**`
- `packages/platform/src/chat/chat-thread-store*.ts`
- `packages/platform/src/chat/library-chat-reader*.ts`
- `apps/desktop/src/main/chat/**`
- `apps/desktop/src/main/ipc/chat-*`

Goal: Persisted, listable, reopenable, deletable chat threads per project (and for no project), and project instructions and files in the chat prompt. Read sections 5, 6 and 7 of docs/design/projects.md.

Build:
- `ChatService`: add `ChatThreadRepository` and `ProjectContextSource` deps. A thread is created lazily on the first successful turn and saved after every successful turn (cancelled or failed sends persist nothing). A failed save is logged, the chat continues in memory and `chat.state.historySaved` is false. Owner resolution at creation: scope Project is `scope.projectId`; Meeting is the meeting's `projectId`; Live is `LiveContextSnapshot.projectId`; AllMeetings is null. Title is the first user message, single line, cut at 60 characters; rename supported. `send()` continues the open thread only when `matchesOpenThread`, otherwise starts a new thread (the old one stays in history). New methods: `openThread(owner,id)` (refused while sending; returns the full `ThreadScope`, messages and `scopeStatus` per section 6), `deleteThread`, `listThreads(owner)`, `renameThread`; state gains `threadId` and `historySaved`. `send` on a thread whose scope is gone (`meeting-missing`, `live-ended`) fails with `scope-gone`. `newChat()` clears the open thread without deleting anything.
- `scope-resolver`: surface `Projects` with a non-null `selectedProjectId` yields kind `Project`; `/projects/none` and `/projects` (null id) yield `AllMeetings`; History, Record and Settings behave as before.
- `context-packer`: Project scope packs "Project: name" plus the project's meetings (instructions and files are NOT repeated there: they come from `packProjectContext`); Meeting and Live scopes prepend the project block when the owner project is known (Live: `ChatService` resolves `snapshot.projectId` through `ProjectContextSource` and fills `snapshot.project` before packing); AllMeetings never has one. `ChatService.pack` calls `packProjectContext` with `projectBudgetFor('chat', provider.id)` and query = user text + last user turn; on the local engine the block size is subtracted from `meetingChars` so the total stays constant (section 7). Rename kind `'Folder'` to `'Project'` in prompt-builder and packers; core string KEYS unchanged; reword comments that mention the old app.
- `LibraryChatReader`: `meetingsInProject`, `listProjects` replace the folder methods; the project note is removed (instructions come from `ProjectContextSource`).
- platform `chat-thread-store`: files at `chats/<id>.json` under the owner directory (layout from Contracts), loose zod `chatThreadFileSchema`, atomic write, per-owner keyed mutex, list by mtime-cached header parse, corrupt or newer-version file reported and skipped without deleting, writes refused unless the state is ready, `activity()`.
- main: `chat-controller` and `chat-handlers` add `chat.threads.list/open/rename/delete` and broadcast `chat.threads.changed`; `compose-chat` wires the new deps.

Tests this lane adds:

Vitest, test first. core: ChatService thread lifecycle with `InMemoryChatThreadRepository` (lazy create, save per turn, nothing saved on cancel, fail or empty answer, failed save sets `historySaved` false and the chat goes on, scope mismatch starts a new thread, `openThread` restores messages and the full scope, scopeStatus for a deleted meeting and an ended Live take, `send` refused with `scope-gone`, refused while sending, delete of the open thread resets state, owner resolution for all four scopes, title cut and rename), scope-resolver cases (Projects surface with and without an id), context-packer Project, Meeting and Live with and without the project block, local budget carve-out keeps the total constant, ordering (project block first), neutralization of forged `Id:` lines in instructions and files. platform: chat-thread-store round trip with a temp dir, corrupt file skipped, unknown per-kind version listed as unsupported and not written, unknown keys preserved, concurrent saves serialized, activity map, writes refused while migrating. main: chat-controller thread methods and handler wiring with fakes; existing chat tests updated for the rename.

### `L3-context-files` Project files, context source and summaries

UI lane: no

Edit surfaces (exclusive):

- `packages/core/src/summaries/**`
- `packages/platform/src/summaries/**`
- `packages/platform/src/projects/project-file-store*.ts`
- `packages/platform/src/projects/project-context-source*.ts`
- `apps/desktop/src/main/summaries/**`
- `apps/desktop/src/main/ipc/summaries-handlers*.ts`
- `apps/desktop/src/main/ipc/project-files-handlers*.ts`
- `apps/desktop/src/main/projects/project-files-controller*.ts`

Goal: Copy project context files into project-owned storage with extracted text, serve them as context, and feed instructions and files to summaries. Read sections 4, 6 and 7 of docs/design/projects.md.

Build:
- platform `project-file-store`: `add(projectId, sourcePath)` validates the path (absolute, local, regular file, not UNC or device, kind via `attachmentKindForName`, not an image, <= `ATTACHMENT_MAX_BYTES`), checks `PROJECT_FILE_MAX_FILES` and `PROJECT_FILES_MAX_TOTAL_CHARS`, hashes the file (sha256, duplicate refused), extracts with the injected threaded extractor (reuse `extractDocument`/`DocumentExtractor` from platform/chat; do NOT modify those files), then commits atomically: `files/<fileId>/original.<ext>` (temp file then rename), `extracted.json`, `meta.json` written last (a directory without `meta.json` is an aborted add and is cleaned on next list). `list`, `remove` (discard to the Recycle Bin when available), `countByProject`, `readDocuments(projectId)` returning `AttachedDocument[]` ordered by `addedAt` with an mtime-keyed in-memory cache. Writes refused unless the state is ready (`storage-*` failure reasons); a file meta with a newer `schemaVersion` is listed as unsupported, never written, unknown keys kept.
- platform `project-context-source`: composes `ProjectRepository.get` and `ProjectFileStore.readDocuments` into the context data; null for an unknown project.
- main: `project-files-controller` and `project-files-handlers` serve `projects.files.pick` (Electron open dialog through injected dialogs), `projects.files.add` (paths from a drop, validated again), `projects.files.remove`, and broadcast `projects.changed` with reason `'files'`.
- summaries (core): `SummaryService` replaces the folders dep and `folderNoteOf` with `ProjectContextSource`; `series-context` and `prompt-builders` rename `folderNote` to `projectInstructions`, the `<folder_note>` block becomes `<project_instructions>` and a new `<project_files>` block carries `packAttachments` excerpts; query = meeting title + notes + first 2000 characters of the transcript; budgets from `projectBudgetFor('summary', provider.id)`; on the local engine the blocks count against `local-prompt-budget` and `local-map-reduce` overhead so the existing 4096-token guarantee holds. The prompt line that explains `<folder_note>` is rewritten for the new blocks. Any failure reading project context leaves it out and the summary still runs (existing rule). `compose-summaries` passes the live proxy for `projectContext`; `summaries-handlers` follow the rename. The platform summaries tests (`packages/platform/src/summaries/**`) are updated for the new dependency.

Tests this lane adds:

Vitest, test first. platform (temp dir): add copies the bytes and extracts text for txt/md/csv/docx/pdf/pptx fixtures from `platform/chat/attachment-fixtures.ts`, refuses images, oversize, encrypted, no-text, duplicates (same sha256 different name), file-count and total-chars limits, UNC paths; aborted add (no `meta.json`) is not listed and is cleaned; remove deletes the directory; `readDocuments` order and cache invalidation on add and remove; newer `schemaVersion` in `meta.json` listed as unsupported; unknown keys survive; writes refused while migrating, in error and newer; a `.md` context file is never picked up as a meeting. context-source: null for unknown project, instructions plus documents for a known one. core summaries: prompt contains `<project_instructions>` and `<project_files>` only when present, instructions neutralized, files ranked by the query, remote vs local budgets, local prompt budget still under its limit with a full project block, failures in the context source never fail the summary; existing tests updated for the rename. main: controller and handler tests with a fake dialog and fake store.

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

Goal: A take records into its project, and the live copilot sees the project instructions and files. Read sections 5, 6 and 7 of docs/design/projects.md.

Build:
- Recording destination: `RecordingService` and `compose-recording` use `ProjectRepository.directoryOf(projectId)` for the audio directory (a null answer falls back to Inbox) and `ProjectRepository.get` for the existence check (`resolveProject` replaces `resolveFolder`; an unknown project falls back to no project as today); `entry-points` use `workspace.state.selectedProjectId` as the fallback (semantics in section 6: set on `/projects/<id>`, null elsewhere); `recording.start` and import (file, YouTube) take `projectId`; the take exposes `projectId` to the live ask. Starting a take never fails because a project was deleted meanwhile, and a take for a project that is unreadable (`unsafe-dir`, not ready) goes to Inbox with `projectId` null.
- Live copilot: `LiveAskDeps.recording()` returns `projectId`; `LiveChatContext` gains `projectId`. Today the Live scope ignores folders and `packLiveSession` only packs title, notes and digest: add the project block. The pill and dock ask (`LiveAskSession`) resolves the block per question (query = the question) through `ProjectContextSource` and passes it to `packLiveSession` as its optional third argument (signature fixed by Contracts; the function lives in core/chat and is not edited here), so the pill, the dock and the Live chat see the same context; budgets from `projectBudgetFor('live', provider.id)`. The digest, question detection and local-model rules (never load the local model mid-take) are unchanged; a context read failure is logged and the ask goes on without it. The Live chat in the main chat service gets `projectId` from `LiveChatContext` (consumed by L2 through the existing `liveContext` callback shape).
- Pill and live handlers follow the rename; no new IPC channel is needed.

Tests this lane adds:

Vitest, test first. core: `packLiveSession` and live-ask-session with and without project block, ordering (session, project, digest, transcript), query passed to the source is the question, budget per engine, failure of the source does not break the ask, live-ask prompt-builder unchanged otherwise. main: recording-service saves into the project directory, falls back to no project when the project is gone, unreadable or while the storage is not ready; entry-points fallback to `selectedProjectId` and to no project when it is null; import-run and youtube-import pass `projectId`; live-ask-handlers `chatContext` carries `projectId`; pill-controller unaffected. All with fakes and temp dirs; existing recording tests updated for the rename.

### `L5-ui` Renderer: Projects tab, project page, No project, sidebar, record destination, chat history, locales

UI lane: yes

Edit surfaces (exclusive):

- `apps/desktop/src/renderer/**`
- `apps/desktop/src/main/i18n-catalog-checks.test.ts`
- `PRODUCT.md`
- `DESIGN.md`

Goal: The whole Projects experience, following the impeccable skill and docs/design-system.md exactly as section 8 specifies (Operate mode, conformance table 8.0). Before any UI edit: load frontend-design, impeccable and accessibility, run impeccable context once, read craft-floor.md. Read sections 6 and 8 of docs/design/projects.md and implement them.

Build:
- `features/meeting-list/` (new, extracted from `features/library` first, in its own commit): `MeetingGrid`, `BulkBar`, `ListHeader`, `use-bulk-actions`, the list store (renamed `meeting-list-store`), filters and preview, scoped by a `scope` prop (all, none, project id). `features/library` and `features/projects` import from it; a boundary test fails on any import between `features/library` and `features/projects`.
- `features/projects/` (new, containers and presentational parts split per the stack rules): `ProjectsRoute` (grid, New project popover, search, sort, pinned group, No project row, empty states, notices of 8.6), `ProjectRoute` (header with inline rename and description edit, primary action, tabs Meetings and Chats, right panel with inline Instructions edit and Context files, menu Rename, Edit description, Pin, Delete with ConfirmDialog and the partial and busy results, the not-found state), `NoProjectRoute` (same frame, no right panel, no Start), `MoveToProjectPopover` (searchable flat list; used by the Library list, bulk bar, meeting preview and session header), `ProjectCard` (stretched-link pattern, pin button above it), `ProjectFilesPanel`, `ChatThreadList`, a kit `Disclosure` in `ui/`, `use-projects` store (zustand, listens to `projects.changed` and `library.changed`), `use-project`, `use-project-files`, `use-chat-threads`, a `useMediaQuery` hook that drives `data-layout` at `(min-width: 960px)`. Start meeting: navigate to `/record?project=<id>&start=1`; `RecordRoute` consumes the parameters with a replacing navigation before any async work, guarded by a ref, then follows the three cases of 8.3 (resolved and idle: start; unknown id: No project, no autostart, Notice; already recording: toast "A meeting is already recording" and the destination line, no second take).
- `router.tsx`, `navigation.ts` and the rail: Record, Projects, Library, Settings; `tagOfPath`, `routeOfTag` and `railRouteOf` handle the tag `Projects` by prefix (`/projects`, `/projects/<id>`, `/projects/none` keep Projects selected); `AppShell` dispatches `publishSelectedProject` with the project id on `/projects/<id>` once the project resolves and `null` on every other route and on leave; reword the NavEntry comment that names the old app's automation ids.
- `features/library`: remove the tree, `Breadcrumbs`, `LibraryFolders`, `use-folder-note`, folder dialogs, `expandedAncestors` and every `folderChain` use; the Library route becomes the flat all-meetings list with a project filter (All projects, No project, one project) feeding `librarySearch` scope and the empty states of 8.4; keep filters, bulk actions (Move becomes Move to project), preview, undo. Remove `folder-visuals`, `ui/Tree.tsx`, `tree-navigation.ts` and their gallery entries and tests; remove the `folder-*` color tokens from `styles` and `DESIGN.md`.
- `features/record`: destinations are projects, flat (No project first, then pinned, then by name), copy says "No project" not Inbox; `use-recording` and `RecordIdle` use `projectId`; the active-take screen shows its destination line.
- `features/chat`: AiPanel gets a History control (popover list of threads for the current owner, New chat, open, rename, delete via `chat.threads.*`), scope label for Project scope, the pinned-scope rule and the read-only state of 6 ("Opening a thread"), the "This chat is not being saved" line when `historySaved` is false; `use-chat-scope` maps the workspace to the new scope kinds.
- `features/session`, `features/settings` and others: replace folder wording and `folderId` usages; `SessionHeader` offers Move to project; `Ui_LibraryFolderShared` and `Ui_LibraryFoldersDamaged` are rewritten for the migrated reality.
- i18n: add every new key to `ui.en.json` and `ui.es.json` (`Ui_<Area><Name>` pattern, same placeholders and order, parity test), reword every existing value that says folder, carpeta or Inbox in the library sense to project, proyecto, No project, Sin proyecto, keep existing key names that core still references; "folder" stays only for the file-system Library location. Natural Latin American Spanish, sentence case.
- Docs: `PRODUCT.md` terminology (project, no project; the Library bullet), `DESIGN.md` folder accent tokens removed, `docs/design-system.md` kit list (Tree removed, Disclosure added).

Tests this lane adds:

Vitest and Testing Library (jsdom), test first for logic: sort (Recent activity, Name, Newest = createdAt), search and pin ordering, last-activity label, move-to-project filtering, `use-projects` reacting to `projects.changed`, navigation helpers (prefix tags, rail selection), record destinations ordering, thread list model, the import-boundary test. Component tests: ProjectsRoute (empty, populated, pinned group, search no results, New project popover empty-name and name-taken, storage states migrating, error and newer, migration notice normal, with skipped and with leftovers, unreadable-project line), ProjectRoute (tabs with keyboard, inline rename and description edit save and cancel and name-taken, instructions inline edit save, cancel, limit counter and failed save, file rows pending, ready and each error, remove file, delete confirmation text, partial and busy delete results, not-found state for an unknown id and for an id removed by `projects.changed`, stacked versus side layout through a mocked `matchMedia` and disclosure open and closed), Chats tab (rows, badge for Meeting deleted, read-only open), NoProjectRoute (Move to project single and bulk, empty state), MoveToProjectPopover keyboard, AiPanel History (list, open pins scope, read-only for a missing meeting, delete, not-saved line), RecordRoute (autostart from `/record?project=<id>&start=1` consumes the URL and does not restart on rerender, unknown id falls back to No project with a Notice and no start, already recording shows the toast and does not start), Library project filter and its empty states. Accessibility: accessible names on every icon button, no button inside a link on cards, focus order, popovers return focus, the delete dialog traps focus, no color-only state (existing axe helpers). Every interactive component state of 8.0 is asserted for card, tab, row, menu and button. `i18n-catalog-checks` parity passes with both locales. All IPC through a typed mock of `window.vozella.invoke`.

### 13.3 Dependencies between lanes and ownership

- **Nothing branches before Contracts merges.** The Contracts phase renames `folderId` and friends inside files that L1 to L5 own (`meeting-markdown.ts`, `workspace.ts`, `library-service`, `library-handlers.ts`, `entry-points.ts`, `scope-resolver.ts`, renderer files, …). Merge order is serial, so this is only safe if every lane branches from the Contracts commit. A lane that finds a Contracts-owned file wrong stops and asks for a contract patch commit.
- L1 may rewrite or delete the Contracts-renamed files inside its globs freely; the same holds for every lane inside its own globs. Ownership of a path passes from the Contracts phase to the lane whose glob contains it when Contracts merges.
- Disjointness is checked mechanically: expand every glob of section 13.2 against `git ls-files`; no path may match two lanes, and every file that mentions `folderId` must match exactly one lane or the Contracts-owned list of 13.1.
- All lanes depend only on the Contracts commit. Cross-lane needs are met by Contracts-owned types, ports, fakes and stubs: L5 codes against the typed IPC channels with a mocked `window.vozella`; L2, L3 and L4 code against `ProjectContextSource` and `packProjectContext` with the in-memory fakes; L1's `LibraryRuntime` already calls the other lanes' factory functions.
- The selected-project semantics of section 6 are the contract between L1 (handler), L4 (consumer) and L5 (publisher).
- Locale files: only L5 edits them. Main-process composition files (`index.ts`, `ipc/handlers.ts`, `compose-projects.ts`, `compose-test-kit.ts`) belong to Contracts.

### 13.4 Merge order

1. contracts
2. L1-storage
3. L3-context-files
4. L2-chat-threads
5. L4-recording-live
6. L5-ui
7. integration (`pnpm check`, remove leftover stubs, resolve barrels)
8. e2e (13.5)

Storage first because it owns the platform barrel and `LibraryRuntime`; context and chat before recording because `LiveChatContext` is consumed by both; UI last because it is the largest and imports every channel. Integration removes any stub left behind and runs `pnpm check`; the Playwright run closes.

### 13.5 E2E

One Playwright spec: `apps/desktop/e2e/projects.spec.ts` (plus updates to `library-data.ts` to seed projects, a legacy-library seeder, and the existing `library*.spec.ts` that still reference the folder tree, which are deleted or rewritten here). Run with `VOZELLA_E2E_BACKGROUND=1 pnpm test:e2e` (never pops windows); every launch uses `launchApp`/`launchAppInRoot` with a mkdtemp `VOZELLA_DATA_ROOT` and `VOZELLA_FAKE_NATIVE=1`, never a real Documents folder. Chat and live prompts are observed through the existing `promptLogFile` double; the file picker through the same dialog double `chat-attachments.spec.ts` uses.

Scenarios (serial where they share a root):
1. Migration on first launch: seed a legacy library in the Library root (`folders.json` with BOM and CRLF, folders Universidad > Calculo and Trabajo > Calculo, a root folder with a note, an orphan `parentId`, 4 meetings with `folderId` plus 1 in Inbox and 1 with an unknown `folderId`). Launch. Projects shows one card per old folder, the colliding ones named "Universidad – Calculo" and "Trabajo – Calculo", the note shows as Instructions of its project, the No project row counts Inbox plus the unknown-folder meeting, meetings open from their cards and links `https://meetinglive.local/meeting/<id>` still resolve; `.vozella/backups` holds a byte-identical copy of `folders.json` and `folders.json` is gone; the migration notice appears once and dismisses.
2. Malformed and app-data sources: a second root whose list sits only in the app data root (adopted and backed up) and a third with duplicate ids, an id that differs only by case, an A->B->A parent cycle and an invalid id. Launch each: no crash, projects for the valid entries, the notice says how many were skipped, every meeting still opens, `.vozella/backups` holds the original bytes.
3. Idempotent relaunch and newer library: close, `launchAppInRoot` on the same root; same projects, no second backup, no notice. Then seed `schemaVersion` 99 in `.vozella/library.json` and relaunch: the newer-version notice shows, project actions are disabled, meetings still list, the manifest is untouched.
4. Create and organize: New project popover with empty name is refused, a duplicate name (different case or accent) shows name-taken, a valid name creates the card; pin moves it to the Pinned group; search and each sort option (Recent activity, Name, Newest) order the grid; inline rename and edit description from the project page.
5. Project page: Edit instructions inline (counter, cancel keeps the old text, save persists across relaunch); Add context file through the picker double (txt and a small pdf or docx fixture) appears with size and pages, a duplicate is refused, an image is refused with a message, Remove deletes it; the file copy exists under `.vozella/projects/<id>/files` and the original path is untouched; no modal opens for any of these edits.
6. Start meeting in this project: the primary button opens Record with the project as destination and starts the take (fake audio) and the URL no longer carries `start` (a reload does not start another take); while recording, clicking Start meeting from another project's page shows "A meeting is already recording" and the destination of the active take is unchanged; stop; the meeting appears first in the project's Meetings tab, its file sits in the project directory, and it is absent from No project. Then open `/record?project=<deleted id>&start=1`: No project is selected, the notice shows and nothing starts.
7. Context reaches the models: with a ready fake provider, a project chat message produces a prompt (`promptLogFile`) containing the instructions and an excerpt of the file ranked by the question; the Live copilot ask during scenario 6 contains the instructions; generating a summary prompt contains `<project_instructions>` and `<project_files>`; a meeting in another project does not.
8. Chat history: send two chats in the project (Project scope) and one in No project; the Chats tab lists only the project's threads newest first; New chat starts another; relaunch and reopen a thread: messages are back and sending continues it; rename; delete removes the file under `chats/` and the row; AiPanel History shows the same list; delete a meeting that has a Meeting-scope thread: the row shows "Meeting deleted" and opens read-only.
9. No project and Move to project: the No project page lists unfiled meetings; Move to project from a row menu and from the bulk bar (3 meetings) moves them, the md and wav files move to the project directory, counts on the cards update, undo works; the Library page project filter shows All projects, No project and one project, and an empty filter shows its message.
10. Delete project: the confirm text names the meeting count; after confirming, the meetings are in No project, files and chats of the project are gone from disk (or in the fake trash), and the card disappears; a project directory that contains another project's directory (migrated parent) leaves the child's meetings in place.
11. Responsive: resize the window across 960 px; the right panel switches between `data-layout="side"` and `"stacked"` with disclosure sections, Instructions and Files stay reachable by keyboard at both sizes.
12. Deep links and cross-window: `#/projects/<unknown id>` shows "Project not found" with a back link and clears the selected project; delete a project from a second window while the first shows its page: the first switches to the not-found state without a reload.
13. Library location change (when the folder-picker double of the existing data-location spec is reusable, else covered by the LibraryRuntime integration test only): switch the Library to a second seeded root, the new root migrates, projects show, the old root is untouched.
14. Quality: axe (serious and critical = 0) on Projects, a project page and No project in light and dark; keyboard only: create a project, open it, add instructions, start a meeting; switch to Spanish: no raw keys and no "folder", "carpeta" or "Inbox" wording anywhere in these screens; reduced motion honored.
