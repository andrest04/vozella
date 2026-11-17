import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_CHARS,
  PROJECT_FILES_MAX_TOTAL_CHARS,
  PROJECT_FILE_MAX_FILES,
  storageFailureOf,
  type AddProjectFileResult,
  type AttachedDocument,
  type Clock,
  type Logger,
  type ProjectFile,
  type ProjectFileFailure,
  type ProjectFileStore,
  type StorageLayout,
  type StorageStateSource,
} from '@vozella/core';
import {
  STORAGE_KIND_VERSIONS,
  extractedTextSchema,
  projectFileMetaSchema,
} from '@vozella/contracts';
import { checkAttachmentPath } from '../chat/attachment-store';
import type { DocumentExtractor } from '../chat/document-extraction';
import { writeFileAtomic } from '../fs/atomic-write';
import { fileLocks, lockKeyFor } from '../fs/keyed-mutex';

export interface ProjectFileStoreDeps {
  readonly layout: StorageLayout;
  readonly extractor: DocumentExtractor;
  readonly state: StorageStateSource;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Electron's `shell.trashItem`; without it a removed file's directory is deleted outright. */
  readonly discard?: (path: string) => Promise<void>;
}

/** A stored file the store left alone: written by a newer app, or damaged. Never written to. */
export interface SkippedProjectFile {
  readonly id: string;
  readonly reason: 'unsupported' | 'corrupt';
}

/** The port plus what the store knows about files it could not use. */
export interface ProjectFileStoreWithSkipped extends ProjectFileStore {
  skipped(projectId: string): Promise<readonly SkippedProjectFile[]>;
}

interface Scan {
  readonly files: readonly { readonly file: ProjectFile; readonly directory: string }[];
  readonly skipped: SkippedProjectFile[];
  /** Directories without a `meta.json`: an add that never finished. */
  readonly aborted: readonly string[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The stored name of the original. A `.md` copy would look like a meeting to the library scan
 * (it reads every `.md` under the Library root), so Markdown keeps a second extension.
 */
const storedOriginalName = (name: string): string => {
  const ext = nodePath.extname(name).toLowerCase();
  return ext === '.md' ? 'original.md.txt' : `original${ext}`;
};

/**
 * The context files of the projects: copied under `.vozella/projects/<id>/files/<fileId>`, their
 * text extracted once. A file is committed as `original.<ext>`, `extracted.json`, then `meta.json`
 * last; a directory without `meta.json` is an aborted add and is removed on the next list.
 */
export function createProjectFileStore(deps: ProjectFileStoreDeps): ProjectFileStoreWithSkipped {
  const { layout, state, logger } = deps;
  const documentCache = new Map<
    string,
    { readonly mtimeMs: number; readonly size: number; readonly document: AttachedDocument }
  >();

  const lockOf = (projectId: string): string => lockKeyFor(layout.filesDirectory(projectId));
  const validId = (id: string): boolean => GUID.test(id);

  async function readMeta(
    directory: string,
    id: string,
  ): Promise<
    | { kind: 'ok'; file: ProjectFile }
    | { kind: 'aborted' }
    | { kind: 'skipped'; reason: SkippedProjectFile['reason'] }
  > {
    let text: string;
    try {
      text = await fs.readFile(nodePath.join(directory, 'meta.json'), 'utf8');
    } catch (error) {
      return isMissing(error) ? { kind: 'aborted' } : { kind: 'skipped', reason: 'corrupt' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'skipped', reason: 'corrupt' };
    }
    const version =
      typeof json === 'object' && json !== null && 'schemaVersion' in json
        ? json.schemaVersion
        : undefined;
    if (typeof version === 'number' && version > STORAGE_KIND_VERSIONS.fileMeta) {
      return { kind: 'skipped', reason: 'unsupported' };
    }
    const parsed = projectFileMetaSchema.safeParse(json);
    if (!parsed.success || parsed.data.id !== id) return { kind: 'skipped', reason: 'corrupt' };
    const meta = parsed.data;
    return {
      kind: 'ok',
      file: {
        id: meta.id,
        name: meta.name,
        kind: meta.kind,
        sizeBytes: meta.sizeBytes,
        pages: meta.pages,
        truncated: meta.truncated,
        textChars: meta.textChars,
        sha256: meta.sha256,
        addedAt: meta.addedAt,
      },
    };
  }

  async function scan(projectId: string): Promise<Scan> {
    const empty: Scan = { files: [], skipped: [], aborted: [] };
    if (!validId(projectId)) return empty;
    const root = layout.filesDirectory(projectId);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (error) {
      if (isMissing(error)) return empty;
      logger.warn('project files not listed', { error });
      return empty;
    }
    const files: { file: ProjectFile; directory: string }[] = [];
    const skipped: SkippedProjectFile[] = [];
    const aborted: string[] = [];
    for (const id of entries.filter(validId).sort()) {
      const directory = layout.fileDirectory(projectId, id);
      const read = await readMeta(directory, id);
      if (read.kind === 'ok') files.push({ file: read.file, directory });
      else if (read.kind === 'aborted') aborted.push(directory);
      else skipped.push({ id, reason: read.reason });
    }
    files.sort(
      (a, b) => a.file.addedAt.localeCompare(b.file.addedAt) || a.file.id.localeCompare(b.file.id),
    );
    return { files, skipped, aborted };
  }

  async function removeDirectory(directory: string): Promise<void> {
    if (deps.discard) await deps.discard(directory);
    else await fs.rm(directory, { recursive: true, force: true });
  }

  async function sweepAborted(projectId: string, aborted: readonly string[]): Promise<void> {
    if (aborted.length === 0 || storageFailureOf(state.current()) !== null) return;
    await fileLocks.run(lockOf(projectId), async () => {
      for (const directory of aborted) {
        // Checked again under the lock: an add that just finished has its meta.json by now.
        const again = await readMeta(directory, nodePath.basename(directory));
        if (again.kind !== 'aborted') continue;
        await fs.rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
          logger.warn('aborted project file add not cleaned', { error });
        });
      }
    });
  }

  async function list(projectId: string): Promise<readonly ProjectFile[]> {
    const found = await scan(projectId);
    await sweepAborted(projectId, found.aborted);
    return found.files.map((entry) => entry.file);
  }

  async function addLocked(projectId: string, sourcePath: string): Promise<AddProjectFileResult> {
    const name = nodePath.basename(sourcePath);
    const fail = (reason: ProjectFileFailure): AddProjectFileResult => ({
      ok: false,
      name,
      reason,
    });
    const refused = storageFailureOf(state.current());
    if (refused !== null) return fail(refused);
    if (!validId(projectId)) return fail('not-a-project');
    const known = await fs
      .stat(layout.projectJsonFile(projectId))
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!known) return fail('not-a-project');

    const check = await checkAttachmentPath(sourcePath, ATTACHMENT_MAX_BYTES);
    if (!check.ok) return fail(check.reason);
    if (check.kind === 'image') return fail('unsupported');

    const current = await scan(projectId);
    if (current.files.length + current.skipped.length >= PROJECT_FILE_MAX_FILES) {
      return fail('project-full');
    }
    let data: Buffer;
    try {
      data = await fs.readFile(sourcePath);
    } catch {
      return fail('not-found');
    }
    // Checked again on the bytes read: the file may have grown since the check.
    if (data.byteLength > ATTACHMENT_MAX_BYTES) return fail('too-large');
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (current.files.some((entry) => entry.file.sha256 === sha256)) return fail('duplicate');

    let extracted;
    try {
      extracted = await deps.extractor(check.kind, data, ATTACHMENT_MAX_CHARS);
    } catch (error) {
      logger.warn('project file extraction failed', { error, kind: check.kind });
      return fail('unreadable');
    }
    if (!extracted.ok) return fail(extracted.reason);

    const textChars = extracted.sections.reduce((sum, section) => sum + section.text.length, 0);
    const usedChars = current.files.reduce((sum, entry) => sum + entry.file.textChars, 0);
    if (usedChars + textChars > PROJECT_FILES_MAX_TOTAL_CHARS) return fail('project-full');

    const id = deps.newId();
    if (!validId(id)) return fail('unreadable');
    const directory = layout.fileDirectory(projectId, id);
    const file: ProjectFile = {
      id,
      name: check.name,
      kind: check.kind,
      sizeBytes: data.byteLength,
      pages: extracted.pages,
      truncated: extracted.truncated,
      textChars,
      sha256,
      addedAt: deps.clock.now().toISOString(),
    };
    try {
      await fs.mkdir(directory, { recursive: true });
      await writeFileAtomic(nodePath.join(directory, storedOriginalName(check.name)), data);
      await writeFileAtomic(
        nodePath.join(directory, 'extracted.json'),
        pretty({
          schemaVersion: STORAGE_KIND_VERSIONS.extractedText,
          pages: extracted.pages,
          truncated: extracted.truncated,
          sections: extracted.sections,
        }),
      );
      // Last: until it exists, the directory is an aborted add.
      await writeFileAtomic(
        nodePath.join(directory, 'meta.json'),
        pretty({ schemaVersion: STORAGE_KIND_VERSIONS.fileMeta, ...file }),
      );
    } catch (error) {
      logger.warn('project file not stored', { error });
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return fail('unreadable');
    }
    return { ok: true, file };
  }

  async function documentOf(entry: {
    readonly file: ProjectFile;
    readonly directory: string;
  }): Promise<AttachedDocument | null> {
    const target = nodePath.join(entry.directory, 'extracted.json');
    try {
      const stat = await fs.stat(target);
      const cached = documentCache.get(target);
      if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.document;
      const json: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
      const version =
        typeof json === 'object' && json !== null && 'schemaVersion' in json
          ? json.schemaVersion
          : undefined;
      if (typeof version === 'number' && version > STORAGE_KIND_VERSIONS.extractedText) {
        documentCache.delete(target);
        return null;
      }
      const parsed = extractedTextSchema.parse(json);
      const document: AttachedDocument = {
        name: entry.file.name,
        kind: entry.file.kind,
        pages: parsed.pages,
        truncated: parsed.truncated,
        sections: parsed.sections.map((section) => ({
          location:
            section.location === null
              ? null
              : { kind: section.location.kind, n: section.location.n },
          text: section.text,
        })),
      };
      documentCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, document });
      return document;
    } catch (error) {
      documentCache.delete(target);
      logger.warn('project file text not read', { error, fileId: entry.file.id });
      return null;
    }
  }

  return {
    list,

    async skipped(projectId) {
      return (await scan(projectId)).skipped;
    },

    async countByProject() {
      const counts = new Map<string, number>();
      let ids: string[];
      try {
        ids = await fs.readdir(layout.projectsDirectory);
      } catch {
        return counts;
      }
      for (const id of ids.filter(validId)) {
        const found = await scan(id);
        const count = found.files.length + found.skipped.length;
        if (count > 0) counts.set(id, count);
      }
      return counts;
    },

    async add(projectId, sourcePath) {
      const name = nodePath.basename(sourcePath);
      if (!validId(projectId)) {
        const refused = storageFailureOf(state.current());
        return { ok: false, name, reason: refused ?? 'not-a-project' };
      }
      try {
        return await fileLocks.run(lockOf(projectId), () => addLocked(projectId, sourcePath));
      } catch (error) {
        logger.warn('project file add failed', { error });
        return { ok: false, name, reason: 'unreadable' };
      }
    },

    async remove(projectId, fileId) {
      if (storageFailureOf(state.current()) !== null) return false;
      if (!validId(projectId) || !validId(fileId)) return false;
      return fileLocks.run(lockOf(projectId), async () => {
        const directory = layout.fileDirectory(projectId, fileId);
        const read = await readMeta(directory, fileId);
        // Unsupported and damaged files are never written to, and a missing one is not there.
        if (read.kind !== 'ok') return false;
        try {
          await removeDirectory(directory);
        } catch (error) {
          logger.warn('project file not removed', { error });
          return false;
        }
        documentCache.delete(nodePath.join(directory, 'extracted.json'));
        return true;
      });
    },

    async readDocuments(projectId) {
      const found = await scan(projectId);
      const documents: AttachedDocument[] = [];
      for (const entry of found.files) {
        const document = await documentOf(entry);
        if (document !== null) documents.push(document);
      }
      return documents;
    },
  };
}
