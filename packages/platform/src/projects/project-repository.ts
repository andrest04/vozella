import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { STORAGE_KIND_VERSIONS, projectRecordSchema, type ProjectRecord } from '@vozella/contracts';
import {
  INBOX_DIR_NAME,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_INSTRUCTIONS_MAX,
  allocateProjectDir,
  createStorageLayout,
  foldProjectName,
  isProjectNameTaken,
  isSafeProjectDir,
  parseGuid,
  stripBom,
  storageFailureOf,
  validateProjectName,
  type Clock,
  type Logger,
  type NewProject,
  type Project,
  type ProjectPatch,
  type ProjectRepository,
  type Result,
  type SkippedProject,
  type StorageLayout,
  type StorageState,
  type StorageStateSource,
} from '@vozella/core';
import { writeFileAtomic } from '../fs/atomic-write';
import { fileLocks, lockKeyFor } from '../fs/keyed-mutex';
import { errorCode, isUnder } from '../library/library-layout';

export interface ProjectRepositoryDeps {
  readonly libraryRoot: string;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly state: StorageStateSource;
  /** Electron's `shell.trashItem`; without it a deleted project's storage is removed outright. */
  readonly discard?: (path: string) => Promise<void>;
}

/** What reading one `project.json` found. */
type Read =
  | {
      readonly kind: 'ok';
      /** The file as parsed, with every key it had, so a rewrite keeps unknown ones. */
      readonly raw: Record<string, unknown>;
      readonly record: ProjectRecord;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'skipped'; readonly skipped: SkippedProject };

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** `project.json` as the one persisted shape: plain UTF-8, LF, two-space indent. */
export const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function toProject(record: ProjectRecord): Project {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    instructions: record.instructions,
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The file-backed project repository: one `project.json` per project under
 * `<Library>/.vozella/projects/<id>`. The directory a project's meetings live in (`dir`) is chosen
 * when the project is created and then frozen.
 *
 * Every file read from disk is untrusted: a corrupt, newer or hand-edited file is reported in
 * `list().skipped` and never deleted, and a `dir` that could aim outside the Library is refused.
 * Writes are refused unless the storage state is `ready`. Mutations run one at a time under a
 * keyed mutex and write atomically; unknown keys of a file survive an update. Deleting a project
 * discards `.vozella/projects/<id>` only, never its meeting directory.
 */
export class FileProjectRepository implements ProjectRepository {
  private readonly layout: StorageLayout;
  private readonly root: string;

  constructor(private readonly deps: ProjectRepositoryDeps) {
    this.root = nodePath.resolve(deps.libraryRoot);
    this.layout = createStorageLayout(this.root, nodePath);
  }

  state(): StorageState {
    return this.deps.state.current();
  }

  // ------------------------------------------------------------------ reads

  async list(): Promise<{ projects: Project[]; skipped: SkippedProject[] }> {
    const { projects, skipped } = await this.readAll();
    return { projects: projects.map((entry) => toProject(entry.record)), skipped };
  }

  async get(id: string): Promise<Project | null> {
    const read = await this.readOne(id);
    return read.kind === 'ok' ? toProject(read.record) : null;
  }

  async directoryOf(id: string | null): Promise<string | null> {
    if (this.state().status !== 'ready') return null;
    if (id === null || parseGuid(id) !== id) return this.layout.inboxDirectory;
    const read = await this.readOne(id);
    if (read.kind === 'missing') return this.layout.inboxDirectory;
    if (read.kind === 'skipped') return null;
    return this.absoluteDir(read.record.dir);
  }

  // ----------------------------------------------------------------- writes

  async create(input: NewProject): Promise<Result<Project>> {
    const refused = this.refusal();
    if (refused) return refused;
    const checked = validateProjectName(input.name);
    if (!checked.ok) return checked;
    const description = input.description ?? '';
    if (description.length > PROJECT_DESCRIPTION_MAX) return { ok: false, reason: 'too-long' };

    return this.locked(async () => {
      try {
        const stored = await this.readAll();
        if (
          isProjectNameTaken(
            stored.projects.map((p) => p.record),
            checked.name,
            null,
          )
        ) {
          return { ok: false, reason: 'name-taken' } as const;
        }
        const id = parseGuid(this.deps.newId());
        if (id === null) return { ok: false, reason: 'io-failed' } as const;

        const taken = [...stored.frozenDirs, ...(await this.libraryEntries())];
        await fs.mkdir(this.root, { recursive: true });
        let dir = '';
        for (let attempt = 0; attempt < 200; attempt += 1) {
          dir = allocateProjectDir(checked.name, taken);
          try {
            await fs.mkdir(nodePath.join(this.root, dir));
            break;
          } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            taken.push(dir);
            dir = '';
          }
        }
        if (dir === '') return { ok: false, reason: 'io-failed' } as const;

        const stamp = this.deps.clock.now().toISOString();
        const record = {
          schemaVersion: STORAGE_KIND_VERSIONS.project,
          id,
          name: checked.name,
          description,
          instructions: '',
          pinned: false,
          dir,
          createdAt: stamp,
          updatedAt: stamp,
        };
        try {
          await writeFileAtomic(this.layout.projectJsonFile(id), serializeJson(record));
        } catch (error) {
          // A crash here leaves an empty directory that the next allocation avoids; a failure
          // we can see is cleaned up, but only if it is still empty.
          await fs.rmdir(nodePath.join(this.root, dir)).catch(() => undefined);
          throw error;
        }
        return { ok: true, value: toProject(record) } as const;
      } catch (error) {
        return this.failed('create', error);
      }
    });
  }

  async update(id: string, patch: ProjectPatch): Promise<Result<Project>> {
    const refused = this.refusal();
    if (refused) return refused;
    return this.locked(async () => {
      try {
        const read = await this.readOne(id);
        if (read.kind === 'missing') return { ok: false, reason: 'not-found' } as const;
        if (read.kind === 'skipped') {
          return {
            ok: false,
            reason: read.skipped.reason === 'unsupported' ? 'storage-newer' : 'corrupt',
          } as const;
        }
        const { record, raw } = read;
        let name = record.name;
        if (patch.name !== undefined) {
          const checked = validateProjectName(patch.name);
          if (!checked.ok) return checked;
          name = checked.name;
        }
        const description = patch.description ?? record.description;
        const instructions = patch.instructions ?? record.instructions;
        if (
          description.length > PROJECT_DESCRIPTION_MAX ||
          instructions.length > PROJECT_INSTRUCTIONS_MAX
        ) {
          return { ok: false, reason: 'too-long' } as const;
        }
        if (name !== record.name) {
          const stored = await this.readAll();
          if (
            isProjectNameTaken(
              stored.projects.map((p) => p.record),
              name,
              id,
            )
          ) {
            return { ok: false, reason: 'name-taken' } as const;
          }
        }
        const pinned = patch.pinned ?? record.pinned;
        if (
          name === record.name &&
          description === record.description &&
          instructions === record.instructions &&
          pinned === record.pinned
        ) {
          return { ok: true, value: toProject(record) } as const;
        }
        const next = {
          ...raw,
          name,
          description,
          instructions,
          pinned,
          updatedAt: this.deps.clock.now().toISOString(),
        };
        await writeFileAtomic(this.layout.projectJsonFile(record.id), serializeJson(next));
        return { ok: true, value: toProject(next as unknown as ProjectRecord) } as const;
      } catch (error) {
        return this.failed('update', error);
      }
    });
  }

  async delete(id: string): Promise<Result<void>> {
    const refused = this.refusal();
    if (refused) return refused;
    return this.locked(async () => {
      try {
        if (parseGuid(id) !== id) return { ok: false, reason: 'not-found' } as const;
        const storage = this.layout.projectDirectory(id);
        const read = await this.readOne(id);
        if (read.kind === 'skipped') {
          // Never discarded: a damaged or newer file may be all that is left of the project's
          // context files and chats, so it is reported and left for the user to repair.
          return {
            ok: false,
            reason: read.skipped.reason === 'unsupported' ? 'storage-newer' : 'corrupt',
          } as const;
        }
        if (read.kind === 'missing' && !(await this.pathExists(storage))) {
          return { ok: false, reason: 'not-found' } as const;
        }
        const frozen = read.kind === 'ok' ? read.record.dir : null;

        // Only this project's own storage. Its meeting directory may contain other projects'.
        try {
          if (this.deps.discard) await this.deps.discard(storage);
          else await fs.rm(storage, { recursive: true, force: true });
        } catch (error) {
          this.deps.logger.warn('could not discard a project', { error: String(error) });
          return { ok: false, reason: 'trash-failed' } as const;
        }

        if (frozen !== null) await this.removeEmptyDirectory(frozen);
        return { ok: true, value: undefined } as const;
      } catch (error) {
        return this.failed('delete', error);
      }
    });
  }

  // ---------------------------------------------------------------- helpers

  private refusal(): {
    readonly ok: false;
    readonly reason: NonNullable<ReturnType<typeof storageFailureOf>>;
  } | null {
    const reason = storageFailureOf(this.state());
    return reason === null ? null : { ok: false, reason };
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return fileLocks.run(`projects:${lockKeyFor(this.root)}`, work);
  }

  private failed(
    what: string,
    error: unknown,
  ): { readonly ok: false; readonly reason: 'io-failed' } {
    this.deps.logger.warn(`project ${what} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'io-failed' };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute, inside the Library, never under the metadata directory. Null when it is not. */
  private absoluteDir(dir: string): string | null {
    if (!isSafeProjectDir(dir)) return null;
    const absolute = nodePath.resolve(this.root, ...dir.split('/'));
    const meta = nodePath.resolve(this.layout.metaDirectory);
    if (!isUnder(absolute, this.root) || absolute === meta || isUnder(absolute, meta)) return null;
    return absolute;
  }

  private async libraryEntries(): Promise<string[]> {
    try {
      return await fs.readdir(this.root);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  private async readOne(id: string): Promise<Read> {
    if (parseGuid(id) !== id) return { kind: 'missing' };
    return this.readAt(id);
  }

  /** `folderName` is a directory under `.vozella/projects`; it is checked against the file's id. */
  private async readAt(folderName: string): Promise<Read> {
    const file = nodePath.join(this.layout.projectsDirectory, folderName, 'project.json');
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      return this.skip(folderName, null, 'corrupt', `unreadable (${String(code)})`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stripBom(content));
    } catch {
      return this.skip(folderName, null, 'corrupt', 'invalid JSON');
    }
    if (!isRecordObject(raw)) return this.skip(folderName, null, 'corrupt', 'not an object');
    const idText = text(raw.id);
    const id = parseGuid(idText) ?? (parseGuid(folderName) === folderName ? folderName : null);
    const dirText = text(raw.dir);

    const version = raw.schemaVersion;
    if (typeof version === 'number' && version > STORAGE_KIND_VERSIONS.project) {
      return this.skip(
        folderName,
        { id, dir: dirText },
        'unsupported',
        `version ${String(version)}`,
      );
    }
    const parsed = projectRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const onlyDir = projectRecordSchema.safeParse({ ...raw, dir: 'x' }).success;
      return this.skip(
        folderName,
        { id, dir: dirText },
        onlyDir ? 'unsafe-dir' : 'corrupt',
        parsed.error.issues[0]?.message ?? 'invalid',
      );
    }
    const record = parsed.data;
    if (record.id !== folderName) {
      return this.skip(
        folderName,
        { id: null, dir: record.dir },
        'corrupt',
        'id differs from its folder',
      );
    }
    if (this.absoluteDir(record.dir) === null) {
      return this.skip(
        folderName,
        { id: record.id, dir: record.dir },
        'unsafe-dir',
        'unsafe directory',
      );
    }
    return { kind: 'ok', raw, record };
  }

  private skip(
    folderName: string,
    found: { id: string | null; dir: string | null } | null,
    reason: SkippedProject['reason'],
    detail: string,
  ): Read {
    this.deps.logger.warn('a project could not be used', { folder: folderName, reason, detail });
    return {
      kind: 'skipped',
      skipped: {
        id: found?.id ?? (parseGuid(folderName) === folderName ? folderName : null),
        dir: found?.dir ?? null,
        reason,
      },
    };
  }

  private async readAll(): Promise<{
    projects: { record: ProjectRecord }[];
    skipped: SkippedProject[];
    frozenDirs: string[];
  }> {
    let names: string[];
    try {
      names = (await fs.readdir(this.layout.projectsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { projects: [], skipped: [], frozenDirs: [] };
      throw error;
    }
    const projects: { record: ProjectRecord }[] = [];
    const skipped: SkippedProject[] = [];
    const frozenDirs: string[] = [];
    for (const name of names) {
      const read = await this.readAt(name);
      if (read.kind === 'ok') {
        projects.push({ record: read.record });
        frozenDirs.push(read.record.dir);
      } else if (read.kind === 'skipped') {
        skipped.push(read.skipped);
        if (read.skipped.dir !== null) frozenDirs.push(read.skipped.dir);
      }
    }
    projects.sort(
      (a, b) =>
        (a.record.createdAt < b.record.createdAt
          ? -1
          : a.record.createdAt > b.record.createdAt
            ? 1
            : 0) || (a.record.id < b.record.id ? -1 : 1),
    );
    return { projects, skipped, frozenDirs };
  }

  /**
   * Removes the directory a deleted project had, only with a non-recursive `rmdir` (so it works
   * only when empty) and only when no other project's directory equals it or lies under it.
   */
  private async removeEmptyDirectory(dir: string): Promise<void> {
    const absolute = this.absoluteDir(dir);
    if (absolute === null) return;
    const others = (await this.readAll()).frozenDirs;
    const folded = foldProjectName(dir);
    const shared = others.some((other) => {
      const f = foldProjectName(other);
      return f === folded || f.startsWith(`${folded}/`);
    });
    // The deleted project is already gone from disk, so it is not among `others`.
    if (shared || folded === foldProjectName(INBOX_DIR_NAME)) return;
    await fs.rmdir(absolute).catch(() => undefined);
  }
}

/** The file-backed project repository. See `FileProjectRepository`. */
export function createProjectRepository(deps: ProjectRepositoryDeps): FileProjectRepository {
  return new FileProjectRepository(deps);
}
