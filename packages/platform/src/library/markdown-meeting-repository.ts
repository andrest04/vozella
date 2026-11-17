import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
  foldSearchText,
  MeetingFormatError,
  MeetingTrashError,
  INBOX_DIR_NAME,
  fileStem,
  meetingListItem,
  meetingSearchText,
  micActivityPathFor,
  parseMeetingMarkdown,
  renderMeetingMarkdown,
  siblingWavPath,
  type Logger,
  type MeetingBody,
  type MeetingDeleteMode,
  type MeetingList,
  type MeetingListItem,
  type MeetingPlacement,
  type MeetingRecord,
  type MeetingRepository,
  type MeetingSearchText,
  type ShadowedMeeting,
  type SkippedMeetingFile,
} from '@vozella/core';
import { writeFileAtomic } from '../fs/atomic-write';
import { KeyedMutex, lockKeyFor } from '../fs/keyed-mutex';
import { FoldedTextCache } from './folded-text-cache';
import {
  errorCode,
  exists,
  isUnder,
  listMarkdownFiles,
  moveFile,
  samePath,
} from './library-layout';

export interface MarkdownMeetingRepositoryOptions {
  /** The Library root: the folder that holds Inbox and the project directories. */
  readonly root: string;
  /** Where a meeting of a project is saved. Null from it means "cannot place now". */
  readonly placement: MeetingPlacement;
  readonly logger?: Logger;
  /** Mutations on one root are serialized here. Defaults to a private mutex. */
  readonly locks?: KeyedMutex;
  /** Test hooks for failures that cannot be provoked with real files. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  /** Where a deleted meeting's files go, such as the Recycle Bin. Without it they are unlinked. */
  readonly discard?: (path: string) => Promise<void>;
  /** How much folded text search may keep in memory. */
  readonly foldedTextBytes?: number;
}

interface IndexEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly item: MeetingListItem | null;
  /** The recording the file names, for protecting a recording another copy still uses. */
  readonly audioFilePath: string | null;
  readonly skipReason: string | null;
}

const READ_CONCURRENCY = 16;
const FOLDED_TEXT_BYTES = 64 * 1024 * 1024;
/** A path as a map key: Windows and macOS volumes ignore case, and so does this key. */
const audioKey = (path: string): string => nodePath.resolve(path).toLowerCase();

/** Copies a file to where a move would have put it, leaving the original. */
const copyFileTo = async (from: string, to: string): Promise<void> => {
  await fs.mkdir(nodePath.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
};
const probe = { fileExists: (path: string): boolean => existsSync(path) };
/** Search never looks at the recording, so its re-reads skip the blocking checks for it. */
const noAudioProbe = { fileExists: (): boolean => false };

/**
 * Meetings as Markdown files under the Library root.
 *
 * A meeting's project is the `projectId` in its frontmatter; the directory it sits in is a
 * convenience. A small in-memory index (id, title, date, snippet per file, keyed by modified
 * time and size) means a Save, Delete or lookup costs one stat per file instead of a parse of
 * every file, and a Library list never re-reads a transcript it has already seen.
 * Indexing already parses each file, so it also keeps the folded text search reads.
 *
 * Two files can hold one id (a copied folder). The newest file wins, ties go to the path, and the
 * other copy is reported as shadowed and is never deleted, moved or rewritten; a recording that a
 * shadowed copy names is never moved or removed with the winner.
 */
export class MarkdownMeetingRepository implements MeetingRepository {
  private readonly cache = new Map<string, IndexEntry>();
  private readonly folded: FoldedTextCache;
  private readonly locks: KeyedMutex;
  private readonly rename: (from: string, to: string) => Promise<void>;
  private readonly unlink: (path: string) => Promise<void>;
  /** Open `batch` calls. While any is open, the first scan stands in for the later ones. */
  private batches = 0;
  private batchScanned = false;
  /** What `list` last reported as shadowed, so the log says it once per change. */
  private reportedShadowed = '';

  constructor(private readonly options: MarkdownMeetingRepositoryOptions) {
    this.folded = new FoldedTextCache(options.foldedTextBytes ?? FOLDED_TEXT_BYTES);
    this.locks = options.locks ?? new KeyedMutex();
    this.rename = options.rename ?? ((from, to) => fs.rename(from, to));
    this.unlink = options.unlink ?? ((path) => fs.unlink(path));
  }

  get root(): string {
    return this.options.root;
  }

  // ------------------------------------------------------------------ reads

  async list(): Promise<MeetingList> {
    const entries = await this.scan();
    const skipped: SkippedMeetingFile[] = [];
    for (const entry of entries) {
      if (entry.skipReason !== null) skipped.push({ path: entry.path, reason: entry.skipReason });
    }
    const items = this.winners(entries)
      .map((e) => e.item)
      .filter((i): i is MeetingListItem => i !== null);
    return { items, skipped, shadowed: this.shadowedOf(entries) };
  }

  async *bodies(filter: (item: MeetingListItem) => boolean): AsyncGenerator<MeetingBody> {
    this.folded.beginPass();
    const wanted = this.winners(await this.scan()).filter((e) => e.item !== null && filter(e.item));
    for (let start = 0; start < wanted.length; start += READ_CONCURRENCY) {
      const chunk = wanted.slice(start, start + READ_CONCURRENCY);
      for (const body of await Promise.all(chunk.map((entry) => this.bodyOf(entry)))) {
        if (body) yield body;
      }
    }
  }

  private async bodyOf(entry: IndexEntry): Promise<MeetingBody | undefined> {
    if (entry.item === null) return undefined;
    const original = (): Promise<MeetingSearchText | null> => this.searchTextAt(entry.path);
    const cached = this.folded.get(entry.path, entry.mtimeMs, entry.size);
    if (cached) return { item: entry.item, folded: cached, original };
    const text = await original();
    if (text === null) return undefined;
    const folded = foldSearchText(text);
    this.folded.set(entry.path, entry.mtimeMs, entry.size, folded);
    return { item: entry.item, folded, original };
  }

  private async searchTextAt(path: string): Promise<MeetingSearchText | null> {
    try {
      const text = await fs.readFile(path, 'utf8');
      return meetingSearchText(parseMeetingMarkdown(path, text, noAudioProbe));
    } catch (error) {
      if (error instanceof MeetingFormatError || this.isSkippable(error)) return null;
      throw error;
    }
  }

  /** The copies that lost to a newer file with the same id. Reported, never touched. */
  private shadowedOf(entries: readonly IndexEntry[]): ShadowedMeeting[] {
    const winners = new Map(this.winners(entries).map((e) => [e.item?.id ?? '', e]));
    const shadowed: ShadowedMeeting[] = [];
    for (const entry of entries) {
      const id = entry.item?.id;
      const kept = id === undefined ? undefined : winners.get(id);
      if (id !== undefined && kept !== undefined && kept.path !== entry.path) {
        shadowed.push({ id, keptPath: kept.path, shadowedPath: entry.path });
      }
    }
    shadowed.sort((a, b) =>
      a.shadowedPath < b.shadowedPath ? -1 : a.shadowedPath > b.shadowedPath ? 1 : 0,
    );
    const key = shadowed.map((s) => `${s.keptPath}|${s.shadowedPath}`).join('\n');
    if (key !== this.reportedShadowed) {
      this.reportedShadowed = key;
      if (shadowed.length > 0) {
        this.options.logger?.warn('two files hold the same meeting id; the newest is used', {
          count: shadowed.length,
        });
      }
    }
    return shadowed;
  }

  private winners(entries: readonly IndexEntry[]): IndexEntry[] {
    const winners = new Map<string, IndexEntry>();
    for (const entry of entries) {
      if (entry.item === null) continue;
      const kept = winners.get(entry.item.id);
      if (kept === undefined || this.prefer(entry, kept)) winners.set(entry.item.id, entry);
    }
    return [...winners.values()];
  }

  async get(id: string): Promise<MeetingRecord | null> {
    const entry = await this.pick(id);
    return entry ? this.parseFile(entry.path) : null;
  }

  // ----------------------------------------------------------------- writes

  save(record: MeetingRecord): Promise<MeetingRecord> {
    return this.locks.run(this.lockKey(), () => this.saveLocked(record));
  }

  delete(id: string, mode: MeetingDeleteMode = 'trash'): Promise<void> {
    return this.locks.run(this.lockKey(), () => this.deleteLocked(id, mode));
  }

  async batch<T>(run: () => Promise<T>): Promise<T> {
    this.batches += 1;
    try {
      return await run();
    } finally {
      this.batches -= 1;
      if (this.batches === 0) this.batchScanned = false;
    }
  }

  private async saveLocked(record: MeetingRecord): Promise<MeetingRecord> {
    const existing = await this.pick(record.id);
    const placed = await this.options.placement.directoryOf(record.projectId);
    if (placed === null && existing !== undefined) return this.saveInPlace(record, existing);
    // A new meeting that cannot be placed yet goes to the Inbox, which always exists.
    const directory = placed ?? nodePath.join(this.root, INBOX_DIR_NAME);
    const desiredStem = fileStem(record.recordedAt, record.title);

    let existingAudio = record.audioFilePath;
    if (existingAudio.trim() === '' && existing) existingAudio = siblingWavPath(existing.path);

    const stem = await this.allocateStem(directory, desiredStem, record.id, existingAudio);
    const markdownPath = nodePath.join(directory, `${stem}.md`);
    const audioPath = nodePath.join(directory, `${stem}.wav`);

    await this.moveAudioIfNeeded(existingAudio, audioPath, await this.audioUsedElsewhere(existing));
    const audioFilePath = (await exists(audioPath)) ? audioPath : record.audioFilePath;
    const saved: MeetingRecord = { ...record, audioFilePath, sourcePath: markdownPath };

    await writeFileAtomic(markdownPath, renderMeetingMarkdown(saved));
    this.cache.delete(markdownPath);
    if (this.batchScanned) {
      const entry = await this.indexFile(markdownPath);
      if (entry) this.cache.set(markdownPath, entry);
    }

    if (existing && !samePath(existing.path, markdownPath) && (await exists(existing.path))) {
      await this.unlink(existing.path);
      this.cache.delete(existing.path);
    }
    return saved;
  }

  /**
   * The projects cannot place a meeting now (the storage is migrating, failed or too new, or the
   * project is unusable). The meeting stays exactly where it is: same file, same recording, and
   * the project it already has in its frontmatter, so an edit of the notes still saves but
   * nothing moves.
   */
  private async saveInPlace(record: MeetingRecord, existing: IndexEntry): Promise<MeetingRecord> {
    const keptProject = existing.item?.projectId ?? null;
    const saved: MeetingRecord = {
      ...record,
      projectId: keptProject,
      sourcePath: existing.path,
    };
    await writeFileAtomic(existing.path, renderMeetingMarkdown(saved));
    this.cache.delete(existing.path);
    if (this.batchScanned) {
      const entry = await this.indexFile(existing.path);
      if (entry) this.cache.set(existing.path, entry);
    }
    return saved;
  }

  /** How a delete removes one file. Only a delete uses this; a move's old file is just unlinked. */
  private removerFor(mode: MeetingDeleteMode): (path: string) => Promise<void> {
    const discard = this.options.discard;
    if (mode === 'permanent' || discard === undefined) return this.unlink;
    return async (path) => {
      try {
        await discard(path);
      } catch (error) {
        throw new MeetingTrashError(error instanceof Error ? error.message : String(error));
      }
    };
  }

  private async deleteLocked(id: string, mode: MeetingDeleteMode): Promise<void> {
    const remove = this.removerFor(mode);
    const entry = await this.pick(id);
    if (!entry || !(await exists(entry.path))) return;

    let storedAudio = '';
    try {
      storedAudio = (await this.parseFile(entry.path)).audioFilePath;
    } catch {
      // An unreadable file still goes; its sibling recording is found by name below.
    }
    // A recording that another file (a shadowed copy) names is not this meeting's to remove.
    const sharedAudio = await this.audioUsedElsewhere(entry);
    const shared = (audio: string): boolean =>
      audio.trim() !== '' && sharedAudio.has(audioKey(audio));
    // The recording goes first: if it is locked this throws while the markdown still exists, so
    // the meeting stays listed and the delete can be retried.
    // a stored path outside the Library is never deleted, only logged.
    if (storedAudio.trim() !== '' && (await exists(storedAudio)) && !shared(storedAudio)) {
      if (isUnder(storedAudio, this.root)) await remove(storedAudio);
      else this.options.logger?.warn('left a recording outside the library in place', { id });
    }
    const sibling = siblingWavPath(entry.path);
    if ((await exists(sibling)) && !shared(sibling)) await remove(sibling);
    for (const audio of new Set([storedAudio, sibling])) {
      if (audio.trim() !== '' && isUnder(audio, this.root) && !shared(audio)) {
        await this.removeMicActivity(audio, remove);
      }
    }
    await remove(entry.path);
    this.cache.delete(entry.path);
  }

  // ---------------------------------------------------------------- helpers

  private lockKey(): string {
    return `meetings:${lockKeyFor(this.root)}`;
  }

  /**
   * The recordings that files other than `entry` name, by normalized path. Deleting or moving
   * a meeting must not take a recording away from a copy that still uses it.
   */
  private async audioUsedElsewhere(entry: IndexEntry | undefined): Promise<Set<string>> {
    const used = new Set<string>();
    if (entry === undefined) return used;
    for (const other of await this.scan()) {
      if (other.path === entry.path) continue;
      if (other.audioFilePath !== null && other.audioFilePath.trim() !== '') {
        used.add(audioKey(other.audioFilePath));
      }
      // The recording next to a file is the file's own, whether or not it names it.
      used.add(audioKey(siblingWavPath(other.path)));
    }
    return used;
  }

  /** A recording the saving meeting already owns does not force " 2". */
  private async allocateStem(
    directory: string,
    desired: string,
    meetingId: string,
    ownedAudio: string,
  ): Promise<string> {
    await fs.mkdir(directory, { recursive: true });
    for (let n = 1; ; n += 1) {
      const stem = n === 1 ? desired : `${desired} ${n}`;
      const markdown = nodePath.join(directory, `${stem}.md`);
      const audio = nodePath.join(directory, `${stem}.wav`);
      if (await exists(markdown)) {
        if ((await this.idAt(markdown)) === meetingId) return stem;
        continue;
      }
      if (!(await exists(audio))) return stem;
      if (ownedAudio.trim() !== '' && samePath(ownedAudio, audio)) return stem;
    }
  }

  private async idAt(path: string): Promise<string | null> {
    const cached = this.cache.get(path);
    if (cached?.item) return cached.item.id;
    try {
      return (await this.parseFile(path)).id;
    } catch (error) {
      if (error instanceof MeetingFormatError || this.isSkippable(error)) return null;
      throw error;
    }
  }

  private async moveAudioIfNeeded(
    source: string,
    destination: string,
    sharedAudio: ReadonlySet<string>,
  ): Promise<void> {
    if (source.trim() === '' || samePath(source, destination)) return;
    if (!(await exists(source))) return;
    // A recording a shadowed copy still names stays where it is: the winner gets its own copy.
    const keep = sharedAudio.has(audioKey(source));
    const transfer = keep
      ? copyFileTo
      : (from: string, to: string) => moveFile(from, to, this.rename);
    await transfer(source, destination);
    // The microphone activity of the recording (the local user as You) goes with it.
    const activity = micActivityPathFor(source);
    if (!(await exists(activity))) return;
    try {
      await transfer(activity, micActivityPathFor(destination));
    } catch (error) {
      this.options.logger?.warn('could not move the microphone activity of a recording', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Best effort: a leftover sidecar only costs the You label, never the delete. */
  private async removeMicActivity(
    audioPath: string,
    remove: (path: string) => Promise<void>,
  ): Promise<void> {
    const activity = micActivityPathFor(audioPath);
    if (!(await exists(activity))) return;
    try {
      await remove(activity);
    } catch (error) {
      this.options.logger?.warn('could not remove the microphone activity of a recording', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async parseFile(path: string): Promise<MeetingRecord> {
    const text = await fs.readFile(path, 'utf8');
    return parseMeetingMarkdown(path, text, probe);
  }

  private isSkippable(error: unknown): boolean {
    const code = errorCode(error);
    return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'ENOENT';
  }

  /** Which of two files with one id is the meeting: the newest, then the path (case-folded). */
  private prefer(candidate: IndexEntry, kept: IndexEntry): boolean {
    if (candidate.mtimeMs !== kept.mtimeMs) return candidate.mtimeMs > kept.mtimeMs;
    return audioKey(candidate.path) < audioKey(kept.path);
  }

  private async pick(id: string): Promise<IndexEntry | undefined> {
    let best: IndexEntry | undefined;
    for (const entry of await this.scan()) {
      if (entry.item?.id !== id) continue;
      if (best === undefined || this.prefer(entry, best)) best = entry;
    }
    return best;
  }

  /** Stats every markdown file and re-reads only those that changed since the last scan. */
  private async scan(): Promise<IndexEntry[]> {
    if (this.batchScanned) return [...this.cache.values()];
    const files = await listMarkdownFiles(this.root);
    const fresh = new Map<string, IndexEntry>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < files.length; index = next++) {
        const path = files[index];
        if (path === undefined) continue;
        const entry = await this.indexFile(path);
        if (entry) fresh.set(path, entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
    this.cache.clear();
    for (const [path, entry] of fresh) this.cache.set(path, entry);
    if (this.batches > 0) this.batchScanned = true;
    return [...fresh.values()];
  }

  private async indexFile(path: string): Promise<IndexEntry | undefined> {
    let stat;
    try {
      stat = await fs.stat(path);
    } catch (error) {
      if (this.isSkippable(error)) return undefined;
      throw error;
    }
    const cached = this.cache.get(path);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

    try {
      const record = await this.parseFile(path);
      this.folded.set(path, stat.mtimeMs, stat.size, foldSearchText(meetingSearchText(record)));
      return {
        path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        skipReason: null,
        item: meetingListItem(record),
        audioFilePath: record.audioFilePath,
      };
    } catch (error) {
      if (error instanceof MeetingFormatError) {
        return {
          path,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          item: null,
          audioFilePath: null,
          skipReason: error.message,
        };
      }
      if (this.isSkippable(error)) {
        // Unreadable right now; not cached by time, so the next scan tries again.
        return {
          path,
          mtimeMs: -1,
          size: -1,
          item: null,
          audioFilePath: null,
          skipReason: String(errorCode(error)),
        };
      }
      throw error;
    }
  }
}
