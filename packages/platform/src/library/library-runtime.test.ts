import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeetingBusyRegistry, renderMeetingMarkdown } from '@vozella/core';
import { foldersToProjects } from '../projects/migrations/001-folders-to-projects';
import type { StorageMigration } from '../projects/storage-migrator';
import type { DataRoots, RunMode } from '../data-root/resolve-data-root';
import { FakeClock } from '../fakes/fake-clock';
import { LibraryRuntime, type LibraryChangeReason } from './library-runtime';
import { ID_A, ID_B, meeting } from './library-test-kit';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-runtime-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noop = (): void => undefined;
const silent = { debug: noop, info: noop, warn: noop, error: noop };

function make(
  options: {
    mode?: RunMode;
    source?: DataRoots['source'];
    picked?: string | null;
    open?: string;
    root?: string;
    migrations?: readonly StorageMigration[];
  } = {},
) {
  const root = options.root ?? dir;
  const roots: DataRoots = {
    appData: path.join(root, 'app'),
    meetings: path.join(root, 'meetings'),
    source: options.source ?? 'env',
  };
  const changes: LibraryChangeReason[] = [];
  const opened: string[] = [];
  const runtime = new LibraryRuntime({
    mode: options.mode ?? 'test',
    roots,
    guard: {
      localAppData: path.join(dir, 'fake-localappdata'),
      documents: path.join(dir, 'fake-documents'),
      tempDir: os.tmpdir(),
    },
    logger: silent,
    clock: new FakeClock('2026-09-05T15:00:00Z'),
    newId: () => crypto.randomUUID(),
    busy: new MeetingBusyRegistry(),
    openPath: (p) => {
      opened.push(p);
      return Promise.resolve(options.open ?? '');
    },
    extractor: () => Promise.resolve({ ok: false, reason: 'unreadable' }),
    pickFolder: () => Promise.resolve(options.picked ?? null),
    version: '1.2.3.4',
    ...(options.migrations ? { migrations: options.migrations } : {}),
    onChanged: (reason) => changes.push(reason),
  });
  return { runtime, roots, changes, opened };
}

describe('project services', () => {
  it('builds the project services beside the meetings and the library service', async () => {
    const { runtime } = make();
    await runtime.start();
    expect(runtime.projects.state()).toEqual({ status: 'ready' });
    expect(runtime.projectService).toBeDefined();
    expect(runtime.projectFiles).toBeDefined();
    expect(runtime.chatThreads).toBeDefined();
    expect(await runtime.projectContext.get('00000000-0000-4000-8000-000000000001')).toBeNull();
  });

  it('rebuilds them when the library location changes, and reads the new root afterwards', async () => {
    const { runtime } = make({ mode: 'production', source: 'default' });
    await runtime.start();
    expect((await runtime.projectService.create({ name: 'Old root' })).ok).toBe(true);
    const target = path.join(dir, 'elsewhere');
    await runtime.setLocation(target);
    expect(runtime.projects.state()).toEqual({ status: 'ready' });
    expect((await runtime.projects.list()).projects).toEqual([]);
    expect(fs.existsSync(path.join(target, '.vozella', 'library.json'))).toBe(true);
  });
});

describe('start', () => {
  it('builds the default library, ensures directories and works', async () => {
    const { runtime, roots } = make();
    await runtime.start();
    expect(fs.existsSync(path.join(roots.meetings, 'Inbox'))).toBe(true);
    expect(fs.existsSync(path.join(roots.appData, 'NemoSpeech'))).toBe(true);
    const created = await runtime.projectService.create({ name: 'Trabajo' });
    expect(created.ok).toBe(true);
    expect(fs.existsSync(path.join(roots.meetings, '.vozella', 'library.json'))).toBe(true);
    expect(fs.existsSync(path.join(roots.meetings, 'Trabajo'))).toBe(true);
    expect(runtime.location()).toMatchObject({
      libraryRoot: roots.meetings,
      appDataRoot: roots.appData,
      source: 'env',
      sharesMeetingLive: false,
      version: '1.2.3.4',
      startupError: null,
    });
  });

  it('migrates an old folder list at start: projects, backup, notice, and the list is gone', async () => {
    const { runtime, roots } = make();
    fs.mkdirSync(roots.meetings, { recursive: true });
    fs.writeFileSync(
      path.join(roots.meetings, 'folders.json'),
      JSON.stringify([
        {
          id: '4b7e0000-0000-4000-8000-000000000001',
          name: 'Trabajo',
          parentId: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    await runtime.start();
    expect((await runtime.projects.list()).projects.map((p) => p.name)).toEqual(['Trabajo']);
    expect(fs.existsSync(path.join(roots.meetings, 'folders.json'))).toBe(false);
    expect(fs.readdirSync(path.join(roots.meetings, '.vozella', 'backups'))).toHaveLength(1);
    expect(await runtime.projectService.migrationNotice()).toMatchObject({ projects: 1 });
    expect(runtime.location().startupError).toBeNull();
  });

  it('reports a failing migration as the startup error and keeps the old list', async () => {
    const failing: StorageMigration = {
      id: '001',
      toVersion: 1,
      run: () => Promise.reject(new Error('disk full')),
    };
    const { runtime, roots } = make({ migrations: [failing] });
    await runtime.start();
    expect(runtime.location().startupError).toBe('disk full');
    expect(runtime.projects.state()).toEqual({ status: 'error', message: 'disk full' });
    expect(runtime.storageState.status).toBe('error');
    expect(fs.existsSync(path.join(roots.meetings, '.vozella', 'library.json'))).toBe(false);
  });

  it('throws if used before start', () => {
    expect(() => make().runtime.service.load()).toThrow(/not been started/);
  });

  it('does not import the layouts of older versions: it only keeps the files', async () => {
    const { runtime, roots } = make();
    fs.mkdirSync(path.join(roots.appData, 'Meetings'), { recursive: true });
    fs.writeFileSync(
      path.join(roots.appData, 'Meetings', `${ID_A}.md`),
      renderMeetingMarkdown(meeting()),
    );
    await runtime.start();
    expect((await runtime.meetings.list()).items).toEqual([]);
    expect(fs.existsSync(path.join(roots.appData, 'Meetings', `${ID_A}.md`))).toBe(true);
    expect(await runtime.projectService.migrationNotice()).toMatchObject({
      legacyLeftovers: ['Meetings'],
    });
  });
});

describe('ordering: nothing works before the migration settled', () => {
  const pausedFor = (when: (root: string) => boolean) => {
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** Resolves once the step is parked at the gate, so a test never guesses how long to wait. */
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const step: StorageMigration = {
      id: '001',
      toVersion: 1,
      run: async (context) => {
        if (when(context.libraryRoot)) {
          reached();
          await gate;
        }
        return foldersToProjects.run(context);
      },
    };
    return { step, release, started };
  };
  /** The step is parked; let everything that is not gated run its course before asserting. */
  const parked = async (started: Promise<void>): Promise<void> => {
    await started;
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((r) => setImmediate(r));
  };

  it('no getter resolves, and a save waits, until the migration is done', async () => {
    const { step, release, started } = pausedFor(() => true);
    const { runtime, roots } = make({ migrations: [step] });
    const settled: string[] = [];
    const starting = runtime.start();
    const list = runtime.projects.list().then(() => settled.push('projects'));
    const created = runtime.projectService
      .create({ name: 'Early' })
      .then(() => settled.push('create'));
    const loaded = runtime.service.load().then(() => settled.push('load'));
    const saved = runtime.meetings.save(meeting()).then(() => settled.push('save'));
    const bodies = (async () => {
      await runtime.meetings.bodies(() => true).next();
      settled.push('bodies');
    })();
    await parked(started);
    expect(settled).toEqual([]);
    expect(runtime.storageState).toEqual({ status: 'migrating' });
    expect(fs.existsSync(path.join(roots.meetings, 'Inbox', '2026-09-01 Standup.md'))).toBe(false);
    release();
    await Promise.all([starting, list, created, loaded, saved, bodies]);
    expect(settled.sort()).toEqual(['bodies', 'create', 'load', 'projects', 'save']);
    expect(fs.existsSync(path.join(roots.meetings, 'Inbox', '2026-09-01 Standup.md'))).toBe(true);
    expect((await runtime.projects.list()).projects.map((p) => p.name)).toEqual(['Early']);
  });

  it('a location change migrates the new root while the old services keep serving, then swaps', async () => {
    const target = path.join(dir, 'elsewhere');
    const { step, release, started } = pausedFor((root) => root === target);
    const { runtime, roots } = make({ mode: 'production', source: 'default', migrations: [step] });
    await runtime.start();
    await runtime.projectService.create({ name: 'In the old root' });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'folders.json'),
      JSON.stringify([
        {
          id: '5b7e0000-0000-4000-8000-000000000001',
          name: 'In the new root',
          parentId: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    const changing = runtime.setLocation(target);
    await parked(started);
    // Still the old root: reads work, and nothing was written under the new root yet.
    expect((await runtime.projects.list()).projects.map((p) => p.name)).toEqual([
      'In the old root',
    ]);
    expect(fs.existsSync(path.join(target, '.vozella'))).toBe(false);
    release();
    expect((await changing).status).toBe('changed');
    expect((await runtime.projects.list()).projects.map((p) => p.name)).toEqual([
      'In the new root',
    ]);
    expect(fs.existsSync(path.join(target, '.vozella', 'library.json'))).toBe(true);
    // The old root was not touched by the switch.
    expect(fs.readdirSync(path.join(roots.meetings, '.vozella', 'projects'))).toHaveLength(1);
  });

  it('migrates the new root with the real step, leaving the old root alone', async () => {
    const target = path.join(dir, 'second');
    const { runtime, roots } = make({ mode: 'production', source: 'default' });
    await runtime.start();
    const before = fs.readdirSync(roots.meetings).sort();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'folders.json'),
      JSON.stringify([
        {
          id: '5b7e0000-0000-4000-8000-000000000002',
          name: 'Second',
          parentId: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    await runtime.setLocation(target);
    expect((await runtime.projects.list()).projects.map((p) => p.name)).toEqual(['Second']);
    expect(fs.existsSync(path.join(target, 'folders.json'))).toBe(false);
    expect(fs.readdirSync(roots.meetings).sort()).toEqual(before);
  });
});

describe('meetings stay put while the projects cannot place them', () => {
  const PROJECT = '6b7e0000-0000-4000-8000-000000000001';
  const OTHER = '6b7e0000-0000-4000-8000-000000000002';

  const seed = (root: string): { file: string; wav: string } => {
    for (const [id, name] of [
      [PROJECT, 'Trabajo'],
      [OTHER, 'Otro'],
    ] as const) {
      const json = path.join(root, '.vozella', 'projects', id, 'project.json');
      fs.mkdirSync(path.dirname(json), { recursive: true });
      fs.writeFileSync(
        json,
        JSON.stringify({
          schemaVersion: 1,
          id,
          name,
          description: '',
          instructions: '',
          pinned: false,
          dir: name,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }
    const file = path.join(root, 'Trabajo', '2026-09-01 Standup.md');
    const wav = file.replace(/\.md$/, '.wav');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(wav, 'RIFF');
    fs.writeFileSync(
      file,
      renderMeetingMarkdown(meeting({ projectId: PROJECT, audioFilePath: wav, sourcePath: file })),
    );
    return { file, wav };
  };

  const failingStep: StorageMigration = {
    id: '001',
    toVersion: 1,
    run: () => Promise.reject(new Error('boom')),
  };
  const quietStep: StorageMigration = { id: '001', toVersion: 1, run: () => Promise.resolve({}) };
  const cases: [string, (root: string) => StorageMigration, string][] = [
    ['an error', () => failingStep, 'storage-error'],
    [
      'a newer library',
      (root) => {
        fs.mkdirSync(path.join(root, '.vozella'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.vozella', 'library.json'),
          JSON.stringify({ schemaVersion: 99, createdAt: 'x', migrations: [] }),
        );
        return quietStep;
      },
      'storage-newer',
    ],
  ];
  it.each(cases)(
    'saving while the storage is in %s moves nothing and refuses a move',
    async (_label, prepare, reason) => {
      const root = path.join(dir, 'meetings');
      const { file, wav } = seed(root);
      const { runtime } = make({ migrations: [prepare(root)] });
      await runtime.start();
      expect(runtime.projects.state().status).not.toBe('ready');
      const before = fs.readdirSync(path.join(root, 'Trabajo')).sort();
      const loaded = await runtime.meetings.get(ID_A);
      expect(loaded?.projectId).toBe(PROJECT);
      const saved = await runtime.meetings.save({
        ...loaded!,
        notes: 'edited while read-only',
        projectId: OTHER,
      });
      expect(saved.sourcePath).toBe(file);
      expect(saved.projectId).toBe(PROJECT);
      expect(fs.readdirSync(path.join(root, 'Trabajo')).sort()).toEqual(before);
      expect(fs.existsSync(wav)).toBe(true);
      expect(fs.existsSync(path.join(root, 'Otro'))).toBe(false);
      expect(await runtime.service.moveMeeting({ meetingId: ID_A, projectId: OTHER })).toEqual({
        ok: false,
        reason,
      });
      expect(fs.readFileSync(file, 'utf8')).toContain('folderId: ' + PROJECT);
      expect(fs.readFileSync(file, 'utf8')).toContain('edited while read-only');
    },
  );

  it('writes a new meeting to the Inbox while read-only', async () => {
    const root = path.join(dir, 'meetings');
    const failing: StorageMigration = {
      id: '001',
      toVersion: 1,
      run: () => Promise.reject(new Error('boom')),
    };
    const { runtime } = make({ migrations: [failing] });
    await runtime.start();
    const saved = await runtime.meetings.save(meeting({ id: ID_B, projectId: PROJECT }));
    expect(saved.sourcePath).toBe(path.join(root, 'Inbox', '2026-09-01 Standup.md'));
  });
});

describe('choosing a folder', () => {
  const meetingLive = () => path.join(dir, 'picked', 'MeetingLive');

  it.each<RunMode>(['test', 'development'])(
    '%s mode refuses a MeetingLive folder',
    async (mode) => {
      const { runtime, roots } = make({ mode, source: 'dev-fallback' });
      await runtime.start();
      const result = await runtime.setLocation(meetingLive());
      expect(result).toMatchObject({ status: 'refused', reason: 'forbidden' });
      expect(runtime.location().libraryRoot).toBe(roots.meetings);
      expect(fs.existsSync(meetingLive())).toBe(false);
    },
  );

  it('production with an environment override still refuses it', async () => {
    const { runtime } = make({ mode: 'production', source: 'env' });
    await runtime.start();
    expect(await runtime.setLocation(meetingLive())).toMatchObject({
      status: 'refused',
      reason: 'forbidden',
    });
  });

  it('production without an override accepts a MeetingLive folder', async () => {
    const { runtime, changes } = make({ mode: 'production', source: 'default' });
    await runtime.start();
    const result = await runtime.setLocation(meetingLive());
    expect(result.status).toBe('changed');
    expect(runtime.location()).toMatchObject({
      libraryRoot: meetingLive(),
      source: 'chosen',
      sharesMeetingLive: true,
    });
    expect(changes).toEqual(['location']);
    expect(fs.existsSync(path.join(meetingLive(), 'Inbox'))).toBe(true);
  });

  it('any other folder is accepted in every mode and is used for new data', async () => {
    const target = path.join(dir, 'elsewhere');
    const { runtime } = make({ mode: 'test' });
    await runtime.start();
    expect((await runtime.setLocation(target)).status).toBe('changed');
    await runtime.projectService.create({ name: 'X' });
    expect(fs.existsSync(path.join(target, 'X'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.vozella', 'library.json'))).toBe(true);
  });

  it('refuses relative paths and files', async () => {
    const { runtime } = make();
    await runtime.start();
    expect(await runtime.setLocation('relative/path')).toMatchObject({ reason: 'not-absolute' });
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(await runtime.setLocation(file)).toMatchObject({
      status: 'refused',
      reason: 'unusable',
    });
  });

  it('remembers the choice across launches and reset returns to the default', async () => {
    const target = path.join(dir, 'elsewhere');
    const first = make();
    await first.runtime.start();
    await first.runtime.setLocation(target);

    const second = make();
    await second.runtime.start();
    expect(second.runtime.location().libraryRoot).toBe(target);

    const reset = await second.runtime.setLocation(null);
    expect(reset).toMatchObject({
      status: 'changed',
      location: { libraryRoot: second.roots.meetings, source: 'env' },
    });
    const third = make();
    await third.runtime.start();
    expect(third.runtime.location().libraryRoot).toBe(third.roots.meetings);
  });

  it('a saved MeetingLive choice is ignored when the guard applies', async () => {
    const prod = make({ mode: 'production', source: 'default' });
    await prod.runtime.start();
    await prod.runtime.setLocation(meetingLive());

    const before = fs.readdirSync(meetingLive()).sort();
    const dev = make({ mode: 'development', source: 'dev-fallback' });
    await dev.runtime.start();
    expect(dev.runtime.location().libraryRoot).toBe(dev.roots.meetings);
    expect(fs.readdirSync(meetingLive()).sort()).toEqual(before);
  });

  it('a damaged choice file falls back to the default', async () => {
    const { runtime, roots } = make();
    fs.mkdirSync(roots.appData, { recursive: true });
    fs.writeFileSync(path.join(roots.appData, 'library-location.json'), '{oops');
    await runtime.start();
    expect(runtime.location().libraryRoot).toBe(roots.meetings);
  });

  it('chooseLocation uses the picker; a cancel changes nothing', async () => {
    const cancelled = make({ picked: null });
    await cancelled.runtime.start();
    expect(await cancelled.runtime.chooseLocation()).toEqual({ status: 'cancelled' });
    expect(cancelled.changes).toEqual([]);

    const target = path.join(dir, 'picked-folder');
    const picked = make({ picked: target });
    await picked.runtime.start();
    expect((await picked.runtime.chooseLocation()).status).toBe('changed');
    expect(picked.runtime.location().libraryRoot).toBe(target);
  });
});

describe('openFolder', () => {
  it('ensures the directories and opens the Library root', async () => {
    const { runtime, opened, roots } = make();
    await runtime.start();
    fs.rmSync(path.join(roots.meetings, 'Inbox'), { recursive: true });
    expect(await runtime.openFolder()).toEqual({ opened: true, error: null });
    expect(opened).toEqual([roots.meetings]);
    expect(fs.existsSync(path.join(roots.meetings, 'Inbox'))).toBe(true);
  });

  it('reports the shell error', async () => {
    const { runtime } = make({ open: 'no handler' });
    await runtime.start();
    expect(await runtime.openFolder()).toEqual({ opened: false, error: 'no handler' });
  });
});

describe('settings', () => {
  it('lives in the app data root and survives a library change', async () => {
    const { runtime, roots } = make();
    await runtime.start();
    await runtime.settings.update({ uiLanguage: 'en' });
    await runtime.setLocation(path.join(dir, 'elsewhere'));
    expect((await runtime.loadSettings()).uiLanguage).toBe('en');
    expect(fs.existsSync(path.join(roots.appData, 'settings.json'))).toBe(true);
  });
});
