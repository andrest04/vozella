import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateStorage } from '../storage-migrator';
import { createFoldersToProjects, type FoldersToProjectsOps } from './001-folders-to-projects';
import {
  F,
  backupFiles,
  createMigrationFixture,
  legacyFoldersText,
  meetingFiles,
  projectJson,
  readManifestFile,
  seedLegacyLibrary,
  sha256,
  tree,
  type MigrationFixture,
} from './migration-test-kit';

let fx: MigrationFixture;
afterEach(() => {
  fx.cleanup();
});

const realOps: FoldersToProjectsOps = {
  readFile: (p) => fs.promises.readFile(p),
  writeNewFile: (p, data) => fs.promises.writeFile(p, data, { flag: 'wx' }),
  removeFile: (p) => fs.promises.unlink(p),
  writeText: async (p, text) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  },
};
const run = (ops: Partial<FoldersToProjectsOps> = {}) =>
  migrateStorage(fx.context, [createFoldersToProjects({ ...realOps, ...ops })]);

describe('001 against a hand-written legacy library', () => {
  it('turns every folder, subfolders included, into a project that keeps its id', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    expect(await run()).toEqual({ status: 'ready' });
    const names = Object.fromEntries(Object.values(F).map((id) => [id, projectJson(fx, id).name]));
    expect(names).toEqual({
      [F.universidad]: 'Universidad',
      [F.calculoU]: 'Universidad – Cálculo',
      [F.derivadas]: 'Derivadas',
      [F.trabajo]: 'Trabajo',
      [F.calculoT]: 'Trabajo – cálculo',
      [F.huerfana]: 'Huérfana',
      [F.conNota]: 'Producto Q4',
    });
  });

  it('turns the note into instructions, converts dates to UTC and records the origin', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    await run();
    expect(projectJson(fx, F.derivadas)).toMatchObject({
      schemaVersion: 1,
      instructions: 'Resumir en español',
      description: '',
      pinned: false,
      createdAt: '2025-03-03T15:00:00.500Z',
      updatedAt: '2025-03-03T15:00:00.500Z',
      origin: { kind: 'folder', parentId: F.calculoU, originalName: 'Derivadas' },
    });
    expect(projectJson(fx, F.conNota).instructions).toBe('Usar tono formal');
    expect(projectJson(fx, F.calculoU).instructions).toBe('');
    // Colors and icons are not carried: they stay in the backup.
    expect(JSON.stringify(projectJson(fx, F.calculoU))).not.toMatch(/color|icon/i);
  });

  it('freezes the old chain directories, so zero files move', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    const before = meetingFiles(fx);
    await run();
    expect(meetingFiles(fx)).toEqual(before);
    expect(projectJson(fx, F.universidad).dir).toBe('Universidad');
    expect(projectJson(fx, F.calculoU).dir).toBe('Universidad/Cálculo');
    expect(projectJson(fx, F.derivadas).dir).toBe('Universidad/Cálculo/Derivadas');
    expect(projectJson(fx, F.calculoT).dir).toBe('Trabajo/cálculo');
    expect(projectJson(fx, F.huerfana).dir).toBe('Huérfana');
  });

  it('writes a hash-verified backup before any project.json, never changing the source bytes', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    const original = fs.readFileSync(fx.foldersInLibrary);
    const seenAtFirstProject: { backups: string[]; same: boolean }[] = [];
    await run({
      writeText: async (p, text) => {
        if (seenAtFirstProject.length === 0) {
          const names = backupFiles(fx);
          seenAtFirstProject.push({
            backups: names,
            same:
              names.length === 1 &&
              fs
                .readFileSync(path.join(fx.context.layout.backupsDirectory, names[0] ?? ''))
                .equals(original),
          });
        }
        await realOps.writeText(p, text);
      },
    });
    expect(seenAtFirstProject).toHaveLength(1);
    expect(seenAtFirstProject[0]?.same).toBe(true);
    expect(backupFiles(fx)[0]).toMatch(/^folders\.v0\.20261116T140300Z\.json$/);
    const manifest = readManifestFile(fx) as {
      migrations: { report: { backup: string; backupSha256: string } }[];
    };
    expect(manifest.migrations[0]?.report.backup).toBe(`backups/${backupFiles(fx)[0]}`);
    expect(manifest.migrations[0]?.report.backupSha256).toBe(sha256(original));
  });

  it('writes the manifest, then deletes the source, and shows the notice once', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    await run();
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(false);
    expect(readManifestFile(fx)).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-11-16T14:03:00.000Z',
      migrations: [
        {
          id: '001-folders-to-projects',
          report: {
            source: 'library',
            projects: 7,
            skipped: [],
            legacyLeftovers: [],
            renamed: [
              { id: F.calculoU, from: 'Cálculo', to: 'Universidad – Cálculo' },
              { id: F.calculoT, from: 'cálculo', to: 'Trabajo – cálculo' },
            ],
          },
        },
      ],
      pendingNotice: {
        kind: 'folders-to-projects',
        projects: 7,
        renamed: 2,
        skipped: 0,
        leftovers: 0,
      },
    });
  });

  it('is idempotent: a second run changes nothing and makes no second backup', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    await run();
    const snapshot = tree(fx.dir).map((f) => [f, fs.readFileSync(path.join(fx.dir, f), 'utf8')]);
    expect(await run()).toEqual({ status: 'ready' });
    expect(tree(fx.dir).map((f) => [f, fs.readFileSync(path.join(fx.dir, f), 'utf8')])).toEqual(
      snapshot,
    );
    expect(backupFiles(fx)).toHaveLength(1);
  });
});

describe('failures leave the old data alone', () => {
  it.each([
    [
      'a missing backup',
      (p: string) =>
        p.includes('backups')
          ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
          : undefined,
    ],
    [
      'an unreadable backup',
      (p: string) =>
        p.includes('backups')
          ? Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }))
          : undefined,
    ],
    [
      'a backup that differs',
      (p: string) =>
        p.includes('backups') ? Promise.resolve(Buffer.from('different')) : undefined,
    ],
  ])('%s aborts with nothing written', async (_label, intercept) => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    const original = fs.readFileSync(fx.foldersInLibrary);
    const state = await run({ readFile: (p) => intercept(p) ?? realOps.readFile(p) });
    expect(state.status).toBe('error');
    expect(fs.readFileSync(fx.foldersInLibrary)).toEqual(original);
    expect(tree(fx.context.layout.metaDirectory)).toEqual([]);
    expect(readManifestFile(fx)).toBeNull();
  });

  it('a corrupt source leaves no manifest, no backup and no project', async () => {
    fx = createMigrationFixture();
    fx.put('Inbox/x.md');
    fs.writeFileSync(fx.foldersInLibrary, '{ not a list');
    const state = await run();
    expect(state.status).toBe('error');
    expect(tree(fx.context.layout.metaDirectory)).toEqual([]);
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(true);
    fs.writeFileSync(fx.foldersInLibrary, '{"not":"a list"}');
    expect((await run()).status).toBe('error');
  });

  it('a crash after some projects resumes: same plan, one backup, every project written', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    let writes = 0;
    const crashing = await run({
      writeText: (p, text) => {
        writes += 1;
        return writes === 3
          ? Promise.reject(new Error('process died'))
          : realOps.writeText(p, text);
      },
    });
    expect(crashing.status).toBe('error');
    expect(readManifestFile(fx)).toBeNull();
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(true);
    expect(await run()).toEqual({ status: 'ready' });
    expect(backupFiles(fx)).toHaveLength(1);
    expect(
      Object.values(F).every((id) => fs.existsSync(fx.context.layout.projectJsonFile(id))),
    ).toBe(true);
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(false);
  });

  it('EBUSY on the source delete keeps manifest v1, makes no rerun and no second backup, and retries the delete later', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    const locked: Partial<FoldersToProjectsOps> = {
      removeFile: () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })),
    };
    expect(await run(locked)).toEqual({ status: 'ready' });
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(true);
    expect((readManifestFile(fx) as { schemaVersion: number }).schemaVersion).toBe(1);
    const projectsBefore = tree(fx.context.layout.projectsDirectory);
    expect(await run(locked)).toEqual({ status: 'ready' });
    expect(backupFiles(fx)).toHaveLength(1);
    expect(tree(fx.context.layout.projectsDirectory)).toEqual(projectsBefore);
    expect((readManifestFile(fx) as { migrations: unknown[] }).migrations).toHaveLength(1);
    // Unlocked on a later launch: the leftover goes, because it still equals the backup.
    expect(await run()).toEqual({ status: 'ready' });
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(false);
  });

  it('leaves a leftover source alone when it no longer equals the backup', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    await run({ removeFile: () => Promise.reject(new Error('EBUSY')) });
    fs.writeFileSync(fx.foldersInLibrary, '[]');
    await run();
    expect(fs.readFileSync(fx.foldersInLibrary, 'utf8')).toBe('[]');
  });

  it('reuses an identical earlier backup instead of making a second one', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    fs.mkdirSync(fx.context.layout.backupsDirectory, { recursive: true });
    const earlier = path.join(
      fx.context.layout.backupsDirectory,
      'folders.v0.20200101T000000Z.json',
    );
    fs.copyFileSync(fx.foldersInLibrary, earlier);
    await run();
    expect(backupFiles(fx)).toEqual(['folders.v0.20200101T000000Z.json']);
  });

  it('never overwrites an existing backup of other bytes: it takes the next name', async () => {
    fx = createMigrationFixture();
    seedLegacyLibrary(fx);
    fs.mkdirSync(fx.context.layout.backupsDirectory, { recursive: true });
    const clash = path.join(fx.context.layout.backupsDirectory, 'folders.v0.20261116T140300Z.json');
    fs.writeFileSync(clash, 'someone else');
    await run();
    expect(fs.readFileSync(clash, 'utf8')).toBe('someone else');
    expect(backupFiles(fx)).toEqual([
      'folders.v0.20261116T140300Z.1.json',
      'folders.v0.20261116T140300Z.json',
    ]);
  });
});

describe('where the list is found', () => {
  it('adopts a list that only sits in the app data root, and backs it up', async () => {
    fx = createMigrationFixture();
    fs.writeFileSync(fx.foldersInAppData, legacyFoldersText());
    expect(await run()).toEqual({ status: 'ready' });
    expect(
      Object.values(F).every((id) => fs.existsSync(fx.context.layout.projectJsonFile(id))),
    ).toBe(true);
    expect(backupFiles(fx)).toHaveLength(1);
    expect(fs.existsSync(fx.foldersInAppData)).toBe(false);
    expect(readManifestFile(fx)).toMatchObject({
      migrations: [{ report: { source: 'app-data' } }],
    });
  });

  it('prefers the Library list, reports the app data one and leaves it untouched', async () => {
    fx = createMigrationFixture();
    fs.writeFileSync(
      fx.foldersInLibrary,
      JSON.stringify([
        {
          id: F.trabajo,
          name: 'Solo Library',
          parentId: null,
          note: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    fs.writeFileSync(fx.foldersInAppData, legacyFoldersText());
    await run();
    expect(fs.readdirSync(fx.context.layout.projectsDirectory)).toEqual([F.trabajo]);
    expect(projectJson(fx, F.trabajo).name).toBe('Solo Library');
    expect(fs.existsSync(fx.foldersInAppData)).toBe(true);
    expect(readManifestFile(fx)).toMatchObject({
      migrations: [{ report: { source: 'library', ignoredSource: 'app-data' } }],
    });
  });

  it('reports the older layouts and does not import them', async () => {
    fx = createMigrationFixture();
    fs.mkdirSync(path.join(fx.appData, 'Meetings'));
    fs.writeFileSync(path.join(fx.appData, 'meetings.json'), '[]');
    fs.writeFileSync(fx.foldersInLibrary, '[]');
    await run();
    expect(readManifestFile(fx)).toMatchObject({
      migrations: [{ report: { legacyLeftovers: ['Meetings', 'meetings.json'] } }],
      pendingNotice: { leftovers: 2 },
    });
    expect(fs.existsSync(path.join(fx.appData, 'Meetings'))).toBe(true);
    expect(fs.existsSync(path.join(fx.appData, 'meetings.json'))).toBe(true);
  });

  it('a fresh install writes manifest v1 with no backup and no notice', async () => {
    fx = createMigrationFixture();
    expect(await run()).toEqual({ status: 'ready' });
    expect(readManifestFile(fx)).toMatchObject({
      schemaVersion: 1,
      migrations: [
        { id: '001-folders-to-projects', report: { source: 'none', projects: 0, backup: null } },
      ],
    });
    expect(readManifestFile(fx)).not.toHaveProperty('pendingNotice');
    expect(backupFiles(fx)).toEqual([]);
  });
});

describe('malformed lists never lose or overwrite data', () => {
  it('dedupes ids (case-only included), breaks loops, skips invalid ids and reports them', async () => {
    fx = createMigrationFixture();
    const a = '2b7e0000-0000-4000-8000-00000000000a';
    const b = '2b7e0000-0000-4000-8000-00000000000b';
    fs.writeFileSync(
      fx.foldersInLibrary,
      JSON.stringify([
        { id: a, name: 'A', parentId: b, createdAt: '2025-01-01T00:00:00Z' },
        { id: b, name: 'B', parentId: a, createdAt: '2025-01-02T00:00:00Z' },
        { id: a.toUpperCase(), name: 'A again', parentId: null, createdAt: '2025-01-03T00:00:00Z' },
        { id: '../../evil', name: 'Evil', parentId: null, createdAt: '2025-01-04T00:00:00Z' },
        { id: F.trabajo, name: 'Self', parentId: F.trabajo, createdAt: '2025-01-05T00:00:00Z' },
        { name: 'No id' },
        'not even an object',
      ]),
    );
    expect(await run()).toEqual({ status: 'ready' });
    expect(fs.readdirSync(fx.context.layout.projectsDirectory).sort()).toEqual(
      [a, b, F.trabajo].sort(),
    );
    expect(projectJson(fx, a).name).toBe('A');
    expect(projectJson(fx, a).origin).toMatchObject({ parentId: b });
    // A loop and a self parent have no old chain to keep: they get fresh, safe directories.
    expect(projectJson(fx, a).dir).toBe('A');
    expect(projectJson(fx, b).dir).toBe('B');
    expect(projectJson(fx, F.trabajo).dir).toBe('Self');
    expect(readManifestFile(fx)).toMatchObject({
      pendingNotice: { projects: 3, skipped: 4 },
      migrations: [
        {
          report: {
            skipped: [
              { index: 2, reason: 'duplicate-id' },
              { index: 3, reason: 'invalid-id' },
              { index: 5, reason: 'invalid-id' },
              { index: 6, reason: 'invalid-id' },
            ],
          },
        },
      ],
    });
    expect(fs.existsSync(path.join(fx.root, '..', 'evil'))).toBe(false);
  });

  it('gives a project a fresh directory when its old chain name is unusable', async () => {
    fx = createMigrationFixture();
    fs.mkdirSync(path.join(fx.root, 'Dotted'));
    fs.writeFileSync(
      fx.foldersInLibrary,
      JSON.stringify([
        { id: F.universidad, name: '.hidden', parentId: null, createdAt: '2025-01-01T00:00:00Z' },
        { id: F.trabajo, name: 'Dotted', parentId: null, createdAt: '2025-01-01T00:00:00Z' },
        { id: F.calculoU, name: 'Meetings', parentId: null, createdAt: '2025-01-01T00:00:00Z' },
        { id: F.calculoT, name: 'Inbox', parentId: null, createdAt: '2025-01-01T00:00:00Z' },
      ]),
    );
    await run();
    expect(projectJson(fx, F.universidad).dir).toBe('hidden');
    expect(projectJson(fx, F.trabajo).dir).toBe('Dotted');
    expect(projectJson(fx, F.calculoU).dir).toBe('Meetings folder');
    expect(projectJson(fx, F.calculoT).dir).toBe('Inbox folder');
  });
});
