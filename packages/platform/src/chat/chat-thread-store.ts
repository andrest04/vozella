import fs from 'node:fs/promises';
import path from 'node:path';
import { chatThreadFileSchema, STORAGE_KIND_VERSIONS } from '@vozella/contracts';
import {
  assertCanonicalGuid,
  storageFailureOf,
  type ChatThread,
  type ChatThreadRepository,
  type ChatThreadSummary,
  type Clock,
  type Logger,
  type Result,
  type StorageLayout,
  type StorageStateSource,
  type ThreadOwner,
} from '@vozella/core';
import { writeFileAtomic } from '../fs/atomic-write';
import { fileLocks, lockKeyFor } from '../fs/keyed-mutex';
import { errorCode } from '../library/library-layout';

export interface ChatThreadStoreDeps {
  readonly layout: StorageLayout;
  readonly state: StorageStateSource;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Electron's `shell.trashItem`; without it a deleted thread file is removed outright. */
  readonly discard?: (path: string) => Promise<void>;
}

/** A thread file the store lists nothing for. It is kept on disk exactly as it is. */
export interface SkippedThread {
  /** The file name without `.json`. */
  readonly id: string;
  readonly reason: 'corrupt' | 'unsupported';
}

/** A JSON object read from disk, keys the app does not know included. */
type Raw = Record<string, unknown>;

type Header =
  | { readonly kind: 'ok'; readonly summary: ChatThreadSummary }
  | { readonly kind: 'skipped'; readonly reason: SkippedThread['reason'] };

interface CachedHeader {
  readonly mtimeMs: number;
  readonly size: number;
  readonly header: Header;
}

type Loaded =
  | { readonly kind: 'ok'; readonly raw: Raw }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'unsupported' };

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The thread files in a chats directory: `<guid>.json`, never a temp or a stray file. */
const THREAD_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/**
 * Saved conversations: `chats/<threadId>.json` under the owner's directory, plain JSON with an
 * explicit `schemaVersion`. Every write is read-modify-write under the owner's lock and atomic
 * (temp file, rename), and refused unless the storage is ready. A file that is corrupt, or newer
 * than this app understands, is reported and skipped: never listed, never written, never deleted
 * on its own. Keys this version does not know are carried through every write.
 */
class FileChatThreadStore implements ChatThreadRepository {
  /** Parsed list headers by file; a file is parsed again only when its time or size changed. */
  private readonly headers = new Map<string, CachedHeader>();
  private readonly skippedByOwner = new Map<string, SkippedThread[]>();
  /** Files already reported, so a list does not log the same problem every time. */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: ChatThreadStoreDeps) {}

  // -- reads -------------------------------------------------------------------------------

  async list(owner: ThreadOwner): Promise<readonly ChatThreadSummary[]> {
    const dir = this.directoryOf(owner);
    if (dir === null) return [];
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT')
        this.deps.logger.warn('chat history unreadable', { error });
      this.skippedByOwner.delete(this.ownerKey(owner));
      return [];
    }
    const summaries: ChatThreadSummary[] = [];
    const skipped: SkippedThread[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const match = THREAD_FILE.exec(name);
      if (match === null) continue;
      const file = path.join(dir, name);
      seen.add(file);
      const header = await this.headerOf(file, match[1] ?? '');
      if (header === null) continue;
      if (header.kind === 'ok') summaries.push(header.summary);
      else skipped.push({ id: match[1] ?? '', reason: header.reason });
    }
    for (const file of [...this.headers.keys()]) {
      if (path.dirname(file) === dir && !seen.has(file)) this.headers.delete(file);
    }
    this.skippedByOwner.set(this.ownerKey(owner), skipped);
    return summaries.sort(
      (a, b) =>
        (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  }

  /** The files the last `list` of this owner set aside, with why. */
  skipped(owner: ThreadOwner): readonly SkippedThread[] {
    return this.skippedByOwner.get(this.ownerKey(owner)) ?? [];
  }

  async get(owner: ThreadOwner, id: string): Promise<ChatThread | null> {
    const file = this.fileOf(owner, id);
    if (file === null) return null;
    const loaded = await this.load(file);
    if (loaded.kind !== 'ok') return null;
    const parsed = chatThreadFileSchema.safeParse(loaded.raw);
    if (!parsed.success || parsed.data.ownerProjectId !== owner || parsed.data.id !== id) {
      return null;
    }
    return parsed.data;
  }

  async activity(): Promise<ReadonlyMap<ThreadOwner, string>> {
    const owners: ThreadOwner[] = [null];
    try {
      for (const entry of await fs.readdir(this.deps.layout.projectsDirectory, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() && this.directoryOf(entry.name) !== null) owners.push(entry.name);
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT')
        this.deps.logger.warn('chat history unreadable', { error });
    }
    const latest = new Map<ThreadOwner, string>();
    for (const owner of owners) {
      const newest = (await this.list(owner))[0];
      if (newest !== undefined) latest.set(owner, newest.updatedAt);
    }
    return latest;
  }

  // -- writes ------------------------------------------------------------------------------

  async save(thread: ChatThread): Promise<Result<void>> {
    const refused = this.refusal();
    if (refused !== null) return { ok: false, reason: refused };
    const file = this.fileOf(thread.ownerProjectId, thread.id);
    if (file === null) return { ok: false, reason: 'io-failed' };
    return this.locked(file, async (): Promise<Result<void>> => {
      try {
        // A project deleted while its chat was open must not be brought back as an orphan directory.
        if (thread.ownerProjectId !== null && !(await this.projectExists(thread.ownerProjectId))) {
          return { ok: false, reason: 'not-found' };
        }
        const existing = await this.load(file);
        if (existing.kind === 'corrupt') return { ok: false, reason: 'corrupt' };
        if (existing.kind === 'unsupported') return { ok: false, reason: 'storage-newer' };
        const merged = existing.kind === 'ok' ? mergeThread(existing.raw, thread) : { ...thread };
        await this.write(file, merged);
        return { ok: true, value: undefined };
      } catch (error) {
        this.deps.logger.warn('chat thread not saved', { error });
        return { ok: false, reason: 'io-failed' };
      }
    });
  }

  async rename(owner: ThreadOwner, id: string, title: string): Promise<boolean> {
    const file = this.fileOf(owner, id);
    if (file === null || this.refusal() !== null) return false;
    return this.locked(file, async () => {
      try {
        const existing = await this.load(file);
        if (existing.kind !== 'ok') return false;
        await this.write(file, { ...existing.raw, title });
        return true;
      } catch (error) {
        this.deps.logger.warn('chat thread not renamed', { error });
        return false;
      }
    });
  }

  async delete(owner: ThreadOwner, id: string): Promise<boolean> {
    const file = this.fileOf(owner, id);
    if (file === null || this.refusal() !== null) return false;
    return this.locked(file, async () => {
      try {
        // A newer file is not ours to remove; a corrupt one is: it is how the user cleans up.
        const existing = await this.load(file);
        if (existing.kind === 'missing' || existing.kind === 'unsupported') return false;
        if (this.deps.discard === undefined) await fs.rm(file, { force: true });
        else await this.deps.discard(file);
        this.headers.delete(file);
        return true;
      } catch (error) {
        this.deps.logger.warn('chat thread not deleted', { error });
        return false;
      }
    });
  }

  // -- helpers -----------------------------------------------------------------------------

  private refusal(): ReturnType<typeof storageFailureOf> {
    return storageFailureOf(this.deps.state.current());
  }

  private async projectExists(projectId: string): Promise<boolean> {
    try {
      await fs.access(this.deps.layout.projectJsonFile(projectId));
      return true;
    } catch {
      return false;
    }
  }

  private ownerKey(owner: ThreadOwner): string {
    return owner ?? '';
  }

  /** The chats directory of an owner, or null for an owner that is not a canonical guid. */
  private directoryOf(owner: ThreadOwner): string | null {
    try {
      return this.deps.layout.chatsDirectory(owner);
    } catch {
      return null;
    }
  }

  /** The file of a thread, or null when an id is not a canonical guid (no path is ever built). */
  private fileOf(owner: ThreadOwner, id: string): string | null {
    try {
      assertCanonicalGuid(id, 'A thread id');
      return this.deps.layout.threadFile(owner, id);
    } catch {
      return null;
    }
  }

  /** One lock per owner directory: saves, renames and deletes of one owner run in turn. */
  private locked<T>(file: string, work: () => Promise<T>): Promise<T> {
    return fileLocks.run(lockKeyFor(path.dirname(file)), work);
  }

  private async write(file: string, value: unknown): Promise<void> {
    await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    this.headers.delete(file);
  }

  private async load(file: string): Promise<Loaded> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
      this.report(file, 'chat thread unreadable', error);
      return { kind: 'corrupt' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'corrupt' };
    }
    if (!isRecord(raw)) return { kind: 'corrupt' };
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > STORAGE_KIND_VERSIONS.thread) {
      return { kind: 'unsupported' };
    }
    return chatThreadFileSchema.safeParse(raw).success ? { kind: 'ok', raw } : { kind: 'corrupt' };
  }

  private async headerOf(file: string, id: string): Promise<Header | null> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(file);
    } catch {
      return null;
    }
    const cached = this.headers.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.header;
    const loaded = await this.load(file);
    if (loaded.kind === 'missing') return null;
    let header: Header;
    if (loaded.kind === 'ok') {
      const parsed = chatThreadFileSchema.parse(loaded.raw);
      header =
        parsed.id === id
          ? {
              kind: 'ok',
              summary: {
                id: parsed.id,
                ownerProjectId: parsed.ownerProjectId,
                scope: { kind: parsed.scope.kind, meetingId: parsed.scope.meetingId },
                title: parsed.title,
                updatedAt: parsed.updatedAt,
                messageCount: parsed.messages.length,
              },
            }
          : { kind: 'skipped', reason: 'corrupt' };
    } else {
      header = { kind: 'skipped', reason: loaded.kind };
    }
    if (header.kind === 'skipped' && !this.reported.has(file)) {
      this.reported.add(file);
      this.deps.logger.warn('chat thread skipped', {
        file: path.basename(file),
        reason: header.reason,
      });
    }
    this.headers.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, header });
    return header;
  }

  private report(file: string, message: string, error: unknown): void {
    if (this.reported.has(file)) return;
    this.reported.add(file);
    this.deps.logger.warn(message, { file: path.basename(file), error });
  }
}

/**
 * The new thread over the stored one: every key the app knows comes from `thread`, every key it
 * does not know (on the thread, its scope, and each message by id) stays as it was stored.
 */
function mergeThread(stored: Raw, thread: ChatThread): Raw {
  const storedMessages = new Map<string, Raw>();
  if (Array.isArray(stored.messages)) {
    for (const message of stored.messages as unknown[]) {
      if (isRecord(message) && typeof message.id === 'string')
        storedMessages.set(message.id, message);
    }
  }
  return {
    ...stored,
    ...thread,
    scope: { ...(isRecord(stored.scope) ? stored.scope : {}), ...thread.scope },
    messages: thread.messages.map((message) => ({
      ...storedMessages.get(message.id),
      ...message,
    })),
  };
}

/**
 * Saved conversations: `chats/<threadId>.json` under the owner's directory. The result also has
 * `skipped(owner)`, the files the last list of that owner set aside.
 */
export function createChatThreadStore(
  deps: ChatThreadStoreDeps,
): ChatThreadRepository & Pick<FileChatThreadStore, 'skipped'> {
  return new FileChatThreadStore(deps);
}
