import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock, Logger, StorageState } from '@vozella/core';
import { createStorageLayout } from '@vozella/core';
import { createProjectRepository, type FileProjectRepository } from './project-repository';
import { StorageStateHolder } from './storage-state';

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ProjectsFixture {
  readonly dir: string;
  readonly root: string;
  readonly appData: string;
  readonly layout: ReturnType<typeof createStorageLayout>;
  readonly state: StorageStateHolder;
  readonly repo: FileProjectRepository;
  /** Paths the repository asked to discard. */
  readonly discarded: string[];
  setState(state: StorageState): void;
  cleanup(): void;
}

export const guid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A repository over a temp Library, with a fixed clock and sequential ids. */
export function createProjectsFixture(
  options: { state?: StorageState; discard?: (path: string) => Promise<void> } = {},
): ProjectsFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-projects-'));
  const root = path.join(dir, 'library');
  const appData = path.join(dir, 'app');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const state = new StorageStateHolder(options.state ?? { status: 'ready' });
  let tick = 0;
  let next = 0;
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 10, 17, 0, 0, tick++)) };
  const discarded: string[] = [];
  const repo = createProjectRepository({
    libraryRoot: root,
    logger: silentLogger,
    clock,
    newId: () => guid(++next),
    state,
    discard:
      options.discard ??
      (async (p) => {
        discarded.push(p);
        await fs.promises.rm(p, { recursive: true, force: true });
      }),
  });
  return {
    dir,
    root,
    appData,
    layout: createStorageLayout(root, path),
    state,
    repo,
    discarded,
    setState: (s) => state.set(s),
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every file under a folder, relative and sorted, for layout assertions. */
export function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/** A project.json as plain data, for assertions. */
export function readProjectJson(fx: ProjectsFixture, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fx.layout.projectJsonFile(id), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Writes a hand-made `project.json` the way a user or a newer app might leave one. */
export function writeProjectJson(fx: ProjectsFixture, id: string, body: unknown): string {
  const file = fx.layout.projectJsonFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return file;
}

export const validRecord = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  id,
  name: 'Hand made',
  description: '',
  instructions: '',
  pinned: false,
  dir: 'Hand made',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
