import type { AttachedDocument } from '../chat/attachments';
import type {
  ChatThread,
  ChatThreadRepository,
  ChatThreadSummary,
  ThreadOwner,
} from '../chat/chat-thread';
import { foldText } from '../library/text-fold';
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_INSTRUCTIONS_MAX,
  PROJECT_NAME_MAX,
  type NewProject,
  type Project,
  type ProjectPatch,
  type SkippedProject,
} from './project';
import {
  PROJECT_FILE_MAX_FILES,
  type AddProjectFileResult,
  type ProjectFile,
} from './project-file';
import {
  storageFailureOf,
  type ProjectContextData,
  type ProjectContextSource,
  type ProjectFileStore,
  type ProjectRepository,
  type Result,
  type StorageState,
  type StorageStateSource,
} from './ports';

/** A storage state a test can set, so the read-only paths are testable. */
export class InMemoryStorageState implements StorageStateSource {
  constructor(private state: StorageState = { status: 'ready' }) {}

  current(): StorageState {
    return this.state;
  }

  set(state: StorageState): void {
    this.state = state;
  }
}

const refusal = (source: StorageStateSource): ProjectFailureResult | null => {
  const reason = storageFailureOf(source.current());
  return reason === null ? null : { ok: false, reason };
};
type ProjectFailureResult = Extract<Result<never>, { ok: false }>;

export interface InMemoryProjectRepositoryOptions {
  readonly state?: StorageStateSource;
  readonly libraryRoot?: string;
  readonly now?: () => string;
  readonly newId?: () => string;
}

const guidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Port fake: projects in memory. Directories are `<root>/<name>`; Inbox is `<root>/Inbox`. */
export class InMemoryProjectRepository implements ProjectRepository {
  readonly records = new Map<string, Project>();
  /** Projects the fake reports as unreadable. */
  skipped: SkippedProject[] = [];
  private readonly source: StorageStateSource;
  private readonly root: string;
  private readonly now: () => string;
  private readonly newId: () => string;
  private counter = 0;

  constructor(options: InMemoryProjectRepositoryOptions = {}) {
    this.source = options.state ?? new InMemoryStorageState();
    this.root = options.libraryRoot ?? '/library';
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId =
      options.newId ??
      (() => {
        this.counter += 1;
        return guidOf(this.counter);
      });
  }

  state(): StorageState {
    return this.source.current();
  }

  list(): Promise<{ projects: Project[]; skipped: SkippedProject[] }> {
    return Promise.resolve({ projects: [...this.records.values()], skipped: [...this.skipped] });
  }

  get(id: string): Promise<Project | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  create(input: NewProject): Promise<Result<Project>> {
    const refused = refusal(this.source);
    if (refused) return Promise.resolve(refused);
    const name = input.name.trim();
    if (name === '') return Promise.resolve({ ok: false, reason: 'empty-name' });
    const description = input.description ?? '';
    if (name.length > PROJECT_NAME_MAX || description.length > PROJECT_DESCRIPTION_MAX) {
      return Promise.resolve({ ok: false, reason: 'too-long' });
    }
    if (this.nameTaken(name, null)) return Promise.resolve({ ok: false, reason: 'name-taken' });
    const stamp = this.now();
    const project: Project = {
      id: this.newId(),
      name,
      description,
      instructions: '',
      pinned: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.records.set(project.id, project);
    return Promise.resolve({ ok: true, value: project });
  }

  update(id: string, patch: ProjectPatch): Promise<Result<Project>> {
    const refused = refusal(this.source);
    if (refused) return Promise.resolve(refused);
    const found = this.records.get(id);
    if (!found) return Promise.resolve({ ok: false, reason: 'not-found' });
    const name = patch.name === undefined ? found.name : patch.name.trim();
    if (name === '') return Promise.resolve({ ok: false, reason: 'empty-name' });
    const description = patch.description ?? found.description;
    const instructions = patch.instructions ?? found.instructions;
    if (
      name.length > PROJECT_NAME_MAX ||
      description.length > PROJECT_DESCRIPTION_MAX ||
      instructions.length > PROJECT_INSTRUCTIONS_MAX
    ) {
      return Promise.resolve({ ok: false, reason: 'too-long' });
    }
    if (this.nameTaken(name, id)) return Promise.resolve({ ok: false, reason: 'name-taken' });
    const next: Project = {
      ...found,
      name,
      description,
      instructions,
      pinned: patch.pinned ?? found.pinned,
      updatedAt: this.now(),
    };
    this.records.set(id, next);
    return Promise.resolve({ ok: true, value: next });
  }

  delete(id: string): Promise<Result<void>> {
    const refused = refusal(this.source);
    if (refused) return Promise.resolve(refused);
    if (!this.records.delete(id)) return Promise.resolve({ ok: false, reason: 'not-found' });
    return Promise.resolve({ ok: true, value: undefined });
  }

  directoryOf(id: string | null): Promise<string | null> {
    if (this.source.current().status !== 'ready') return Promise.resolve(null);
    const project = id === null ? undefined : this.records.get(id);
    return Promise.resolve(`${this.root}/${project ? project.name : 'Inbox'}`);
  }

  private nameTaken(name: string, exceptId: string | null): boolean {
    const folded = foldText(name);
    for (const project of this.records.values()) {
      if (project.id !== exceptId && foldText(project.name) === folded) return true;
    }
    return false;
  }
}

/** What a test registers for a path, so `add` has something to read. */
export interface InMemorySourceFile {
  readonly name: string;
  readonly kind: ProjectFile['kind'];
  readonly sizeBytes: number;
  readonly pages?: number | null;
  readonly text: string;
}

/** Port fake: project files in memory. Register source files with `registerSource`. */
export class InMemoryProjectFileStore implements ProjectFileStore {
  private readonly files = new Map<string, { file: ProjectFile; text: string }[]>();
  private readonly sources = new Map<string, InMemorySourceFile>();
  private counter = 0;

  constructor(
    private readonly source: StorageStateSource = new InMemoryStorageState(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  registerSource(path: string, file: InMemorySourceFile): void {
    this.sources.set(path, file);
  }

  list(projectId: string): Promise<readonly ProjectFile[]> {
    return Promise.resolve((this.files.get(projectId) ?? []).map((entry) => entry.file));
  }

  countByProject(): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(
      new Map([...this.files].map(([projectId, entries]) => [projectId, entries.length])),
    );
  }

  add(projectId: string, sourcePath: string): Promise<AddProjectFileResult> {
    const picked = this.sources.get(sourcePath);
    const name = picked?.name ?? sourcePath;
    const reason = storageFailureOf(this.source.current());
    if (reason !== null) return Promise.resolve({ ok: false, name, reason });
    if (!picked) return Promise.resolve({ ok: false, name, reason: 'not-found' });
    const entries = this.files.get(projectId) ?? [];
    if (entries.length >= PROJECT_FILE_MAX_FILES) {
      return Promise.resolve({ ok: false, name, reason: 'project-full' });
    }
    const sha256 = `sha-${picked.text}`;
    if (entries.some((entry) => entry.file.sha256 === sha256)) {
      return Promise.resolve({ ok: false, name, reason: 'duplicate' });
    }
    this.counter += 1;
    const file: ProjectFile = {
      id: guidOf(1_000 + this.counter),
      name: picked.name,
      kind: picked.kind,
      sizeBytes: picked.sizeBytes,
      pages: picked.pages ?? null,
      truncated: false,
      textChars: picked.text.length,
      sha256,
      addedAt: this.now(),
    };
    this.files.set(projectId, [...entries, { file, text: picked.text }]);
    return Promise.resolve({ ok: true, file });
  }

  remove(projectId: string, fileId: string): Promise<boolean> {
    if (storageFailureOf(this.source.current()) !== null) return Promise.resolve(false);
    const entries = this.files.get(projectId) ?? [];
    const kept = entries.filter((entry) => entry.file.id !== fileId);
    this.files.set(projectId, kept);
    return Promise.resolve(kept.length !== entries.length);
  }

  readDocuments(projectId: string): Promise<readonly AttachedDocument[]> {
    return Promise.resolve(
      (this.files.get(projectId) ?? []).map(({ file, text }) => ({
        name: file.name,
        kind: file.kind,
        pages: file.pages,
        truncated: file.truncated,
        sections: [{ location: null, text }],
      })),
    );
  }
}

const ownerKey = (owner: ThreadOwner): string => owner ?? '';

/** Port fake: chat threads in memory. */
export class InMemoryChatThreadRepository implements ChatThreadRepository {
  private readonly threads = new Map<string, ChatThread>();

  constructor(private readonly source: StorageStateSource = new InMemoryStorageState()) {}

  private key(owner: ThreadOwner, id: string): string {
    return `${ownerKey(owner)}|${id}`;
  }

  list(owner: ThreadOwner): Promise<readonly ChatThreadSummary[]> {
    return Promise.resolve(
      [...this.threads.values()]
        .filter((thread) => thread.ownerProjectId === owner)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map((thread) => ({
          id: thread.id,
          ownerProjectId: thread.ownerProjectId,
          scope: thread.scope,
          title: thread.title,
          updatedAt: thread.updatedAt,
          messageCount: thread.messages.length,
        })),
    );
  }

  get(owner: ThreadOwner, id: string): Promise<ChatThread | null> {
    return Promise.resolve(this.threads.get(this.key(owner, id)) ?? null);
  }

  save(thread: ChatThread): Promise<Result<void>> {
    const reason = storageFailureOf(this.source.current());
    if (reason !== null) return Promise.resolve({ ok: false, reason });
    this.threads.set(this.key(thread.ownerProjectId, thread.id), thread);
    return Promise.resolve({ ok: true, value: undefined });
  }

  rename(owner: ThreadOwner, id: string, title: string): Promise<boolean> {
    const found = this.threads.get(this.key(owner, id));
    if (!found || storageFailureOf(this.source.current()) !== null) return Promise.resolve(false);
    this.threads.set(this.key(owner, id), { ...found, title });
    return Promise.resolve(true);
  }

  delete(owner: ThreadOwner, id: string): Promise<boolean> {
    if (storageFailureOf(this.source.current()) !== null) return Promise.resolve(false);
    return Promise.resolve(this.threads.delete(this.key(owner, id)));
  }

  activity(): Promise<ReadonlyMap<ThreadOwner, string>> {
    const latest = new Map<ThreadOwner, string>();
    for (const thread of this.threads.values()) {
      const seen = latest.get(thread.ownerProjectId);
      if (seen === undefined || seen < thread.updatedAt) {
        latest.set(thread.ownerProjectId, thread.updatedAt);
      }
    }
    return Promise.resolve(latest);
  }
}

/** Port fake: the context of each project, set by the test. */
export class InMemoryProjectContextSource implements ProjectContextSource {
  private readonly data = new Map<string, ProjectContextData>();

  set(context: ProjectContextData): void {
    this.data.set(context.projectId, context);
  }

  get(projectId: string): Promise<ProjectContextData | null> {
    return Promise.resolve(this.data.get(projectId) ?? null);
  }
}
