import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { STORAGE_KIND_VERSIONS } from '@vozella/contracts';
import {
  PROJECT_INSTRUCTIONS_MAX,
  allocateProjectDir,
  isSafeProjectDir,
  parseGuid,
  planProjects,
  type PlannedProject,
} from '@vozella/core';
import { writeFileAtomic } from '../../fs/atomic-write';
import { errorCode } from '../../library/library-layout';
import { serializeJson } from '../project-repository';
import type { MigrationContext, MigrationOutcome, StorageMigration } from '../storage-migrator';
import { legacyDirectoryName } from './legacy-directory';
import { readLegacyFolders } from './legacy-folders-reader';

export const MIGRATION_ID = '001-folders-to-projects';
const SOURCE_FILE = 'folders.json';
const LEFTOVER_NAMES = ['Meetings', 'Recordings', 'meetings.json'] as const;

/** The calls the step makes on files. Tests replace them to simulate a failing disk. */
export interface FoldersToProjectsOps {
  readFile(path: string): Promise<Buffer>;
  /** Creates the file and fails with `EEXIST` when it is there: a backup is never overwritten. */
  writeNewFile(path: string, data: Buffer): Promise<void>;
  removeFile(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
}

const realOps: FoldersToProjectsOps = {
  readFile: (path) => fs.readFile(path),
  writeNewFile: (path, data) => fs.writeFile(path, data, { flag: 'wx' }),
  removeFile: (path) => fs.unlink(path),
  writeText: (path, text) => writeFileAtomic(path, text),
};

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** The backup could not be proven identical to the source, so the step stops with nothing written. */
export class BackupVerificationError extends Error {
  constructor(detail: string) {
    super(`The backup of the old folder list could not be verified: ${detail}`);
    this.name = 'BackupVerificationError';
  }
}

function backupStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** An earlier attempt may have left a backup of exactly these bytes: reuse it, never add a second. */
async function findIdenticalBackup(
  directory: string,
  hash: string,
  ops: FoldersToProjectsOps,
): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  for (const name of names.filter((n) => /^folders\.v0\..*\.json$/.test(n)).sort()) {
    try {
      if (sha256(await ops.readFile(nodePath.join(directory, name))) === hash) return name;
    } catch {
      // An unreadable earlier backup is simply not reusable.
    }
  }
  return null;
}

/** Copies the source into `.vozella/backups` and proves the copy by hashing it again. */
async function backUp(
  context: MigrationContext,
  bytes: Buffer,
  hash: string,
  ops: FoldersToProjectsOps,
): Promise<string> {
  const directory = context.layout.backupsDirectory;
  const reused = await findIdenticalBackup(directory, hash, ops);
  if (reused !== null) return reused;

  await fs.mkdir(directory, { recursive: true });
  const base = `folders.v0.${backupStamp(context.clock.now())}`;
  let name = '';
  for (let counter = 0; counter < 1_000; counter += 1) {
    name = `${base}${counter === 0 ? '' : `.${String(counter)}`}.json`;
    try {
      await ops.writeNewFile(nodePath.join(directory, name), bytes);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      name = '';
    }
  }
  if (name === '') throw new BackupVerificationError('no free backup name');
  const path = nodePath.join(directory, name);
  try {
    const copy = await ops.readFile(path);
    if (sha256(copy) !== hash)
      throw new BackupVerificationError('the copy differs from the source');
  } catch (error) {
    await fs.rm(path, { force: true }).catch(() => undefined);
    if (error instanceof BackupVerificationError) throw error;
    throw new BackupVerificationError(error instanceof Error ? error.message : String(error));
  }
  return name;
}

/** The directories each project gets: the old chain path, or a fresh one when it cannot be used. */
async function chooseDirectories(
  plan: readonly PlannedProject[],
  rawNames: ReadonlyMap<string, string>,
  libraryRoot: string,
): Promise<Map<string, string>> {
  const byId = new Map(plan.map((p) => [p.id, p]));
  const chosen = new Map<string, string>();
  const needsFresh: PlannedProject[] = [];
  for (const project of plan) {
    if (project.cycleBroken) {
      needsFresh.push(project);
      continue;
    }
    const segments: string[] = [];
    for (
      let at: PlannedProject | undefined = project;
      at !== undefined && segments.length <= 64;
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    ) {
      segments.unshift(legacyDirectoryName(rawNames.get(at.id) ?? at.originalName));
    }
    const dir = segments.join('/');
    if (isSafeProjectDir(dir)) chosen.set(project.id, dir);
    else needsFresh.push(project);
  }
  if (needsFresh.length > 0) {
    let onDisk: string[] = [];
    try {
      onDisk = await fs.readdir(libraryRoot);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const taken = [...onDisk, ...chosen.values()];
    for (const project of needsFresh) {
      const dir = allocateProjectDir(project.name, taken);
      taken.push(dir);
      chosen.set(project.id, dir);
    }
  }
  return chosen;
}

const sourcePathOf = (context: MigrationContext, source: string): string | null =>
  source === 'library'
    ? nodePath.join(context.libraryRoot, SOURCE_FILE)
    : source === 'app-data'
      ? nodePath.join(context.appDataRoot, SOURCE_FILE)
      : null;

/**
 * Step 001: the nested folder list becomes flat projects (storage version 0 to 1).
 *
 * Plan first (pure), then a hash-verified backup, then one `project.json` per project, then the
 * migrator commits the manifest and only then is the old list deleted. No meeting file moves: a
 * project keeps the directory its meetings already sit in. Rerunning a half-finished step
 * recomputes the same plan and overwrites the same bytes.
 */
export function createFoldersToProjects(ops: FoldersToProjectsOps = realOps): StorageMigration {
  return {
    toVersion: STORAGE_KIND_VERSIONS.manifest,
    id: MIGRATION_ID,

    async run(context): Promise<MigrationOutcome> {
      const candidates = [
        { kind: 'library', path: nodePath.join(context.libraryRoot, SOURCE_FILE) },
        { kind: 'app-data', path: nodePath.join(context.appDataRoot, SOURCE_FILE) },
      ] as const;
      const found: (typeof candidates)[number][] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = nodePath.resolve(candidate.path).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (await exists(candidate.path)) found.push(candidate);
      }
      const source = found[0];
      const ignored = found[1];

      const legacyLeftovers: string[] = [];
      for (const name of LEFTOVER_NAMES) {
        if (await exists(nodePath.join(context.appDataRoot, name))) legacyLeftovers.push(name);
      }

      if (source === undefined) {
        return {
          report: {
            source: 'none',
            projects: 0,
            renamed: [],
            skipped: [],
            legacyLeftovers,
            backup: null,
            backupSha256: null,
          },
          ...(legacyLeftovers.length > 0
            ? {
                pendingNotice: {
                  kind: 'folders-to-projects' as const,
                  projects: 0,
                  renamed: 0,
                  skipped: 0,
                  leftovers: legacyLeftovers.length,
                },
              }
            : {}),
        };
      }

      // 1 and 2: read and plan. Nothing is written until the plan exists.
      const bytes = await ops.readFile(source.path);
      const entries = readLegacyFolders(bytes.toString('utf8'));
      const plan = planProjects(entries, { now: context.clock.now().toISOString() });
      const rawNames = new Map<string, string>();
      entries.forEach((entry) => {
        const id = parseGuid(entry.id);
        if (id !== null && !rawNames.has(id)) rawNames.set(id, entry.name ?? '');
      });
      const dirs = await chooseDirectories(plan.projects, rawNames, context.libraryRoot);

      // 5: the backup is the only record of the old hierarchy; nothing else is written before it.
      const hash = sha256(bytes);
      const backupName = await backUp(context, bytes, hash, ops);

      // 6: one project.json per project; the same input gives the same bytes.
      for (const project of plan.projects) {
        const dir = dirs.get(project.id);
        if (dir === undefined) throw new Error('unreachable: a project has no directory');
        await ops.writeText(
          context.layout.projectJsonFile(project.id),
          serializeJson({
            schemaVersion: STORAGE_KIND_VERSIONS.project,
            id: project.id,
            name: project.name,
            description: '',
            instructions: project.instructions.slice(0, PROJECT_INSTRUCTIONS_MAX),
            pinned: false,
            dir,
            createdAt: project.createdAt,
            updatedAt: project.createdAt,
            origin: {
              kind: 'folder',
              parentId: project.originalParentId,
              originalName: project.originalName,
            },
          }),
        );
      }

      // 7: the migrator writes the manifest; only then does the old list go.
      const sourceKind = source.kind;
      return {
        report: {
          source: sourceKind,
          projects: plan.projects.length,
          renamed: plan.renamed.map(({ id, from, to }) => ({ id, from, to })),
          skipped: plan.skipped.map(({ index, reason }) => ({ index, reason })),
          legacyLeftovers,
          backup: `backups/${backupName}`,
          backupSha256: hash,
          ...(ignored ? { ignoredSource: ignored.kind } : {}),
        },
        pendingNotice: {
          kind: 'folders-to-projects',
          projects: plan.projects.length,
          renamed: plan.renamed.length,
          skipped: plan.skipped.length,
          leftovers: legacyLeftovers.length,
        },
        afterCommit: () => ops.removeFile(source.path),
      };
    },

    /**
     * The manifest is committed but the old list may still be there (a locked file the first time).
     * It is deleted only when it is still exactly what the backup holds; a changed file is left.
     */
    async settle(context, entry) {
      const report = entry.report;
      if (report === undefined || report.backupSha256 === null) return;
      const path = sourcePathOf(context, report.source);
      if (path === null || !(await exists(path))) return;
      if (sha256(await ops.readFile(path)) !== report.backupSha256) {
        context.logger.warn('the old folder list changed after the migration; it was left alone');
        return;
      }
      await ops.removeFile(path);
    },
  };
}

export const foldersToProjects: StorageMigration = createFoldersToProjects();
