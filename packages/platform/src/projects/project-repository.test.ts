import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectsFixture,
  guid,
  readProjectJson,
  tree,
  validRecord,
  writeProjectJson,
  type ProjectsFixture,
} from './project-repository-test-kit';

let fx: ProjectsFixture;
afterEach(() => {
  fx.cleanup();
});

const must = <T>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
};

describe('create', () => {
  it('writes a plain project.json, allocates the directory and reserves it on disk', async () => {
    fx = createProjectsFixture();
    const project = must(await fx.repo.create({ name: ' Cálculo ', description: 'Clases' }));
    expect(project).toMatchObject({
      id: guid(1),
      name: 'Cálculo',
      description: 'Clases',
      instructions: '',
      pinned: false,
    });
    expect(fs.statSync(path.join(fx.root, 'Cálculo')).isDirectory()).toBe(true);
    const text = fs.readFileSync(fx.layout.projectJsonFile(guid(1)), 'utf8');
    expect(text).not.toContain('\r');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      dir: 'Cálculo',
      createdAt: project.createdAt,
    });
  });

  it('refuses empty, over-long and duplicate names (case and accents do not count)', async () => {
    fx = createProjectsFixture();
    await fx.repo.create({ name: 'Cálculo' });
    expect(await fx.repo.create({ name: '  ' })).toEqual({ ok: false, reason: 'empty-name' });
    expect(await fx.repo.create({ name: 'x'.repeat(121) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(await fx.repo.create({ name: 'CALCULO' })).toEqual({ ok: false, reason: 'name-taken' });
    expect(await fx.repo.create({ name: 'n', description: 'x'.repeat(501) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('avoids directories that already exist: Inbox, user folders, loose meeting folders and trailing dots', async () => {
    fx = createProjectsFixture();
    for (const name of ['Meetings', 'Recordings', 'Mi carpeta'])
      fs.mkdirSync(path.join(fx.root, name));
    expect(must(await fx.repo.create({ name: 'Inbox' })).id).toBe(guid(1));
    expect(must(await fx.repo.create({ name: 'meetings' })).id).toBe(guid(2));
    expect(must(await fx.repo.create({ name: 'MI CARPETA' })).id).toBe(guid(3));
    expect(must(await fx.repo.create({ name: 'Trabajo...' })).id).toBe(guid(4));
    expect(must(await fx.repo.create({ name: 'NUL' })).id).toBe(guid(5));
    const dirs = [1, 2, 3, 4, 5].map((n) => readProjectJson(fx, guid(n)).dir);
    expect(dirs).toEqual(['Inbox 2', 'meetings 2', 'MI CARPETA 2', 'Trabajo', 'NUL project']);
  });

  it('never makes a project a prefix or a child of another project directory', async () => {
    fx = createProjectsFixture();
    writeProjectJson(
      fx,
      guid(50),
      validRecord(guid(50), { name: 'Cálculo', dir: 'Universidad/Cálculo' }),
    );
    const project = must(await fx.repo.create({ name: 'Universidad' }));
    expect(readProjectJson(fx, project.id).dir).toBe('Universidad 2');
  });

  it('keeps the directory of a skipped project reserved', async () => {
    fx = createProjectsFixture();
    writeProjectJson(fx, guid(60), { schemaVersion: 99, id: guid(60), dir: 'Futuro' });
    const project = must(await fx.repo.create({ name: 'Futuro' }));
    expect(readProjectJson(fx, project.id).dir).toBe('Futuro 2');
  });

  it('removes the reserved directory again when the write fails', async () => {
    fx = createProjectsFixture();
    // A file where the project storage directory should go makes the atomic write fail.
    fs.mkdirSync(fx.layout.projectsDirectory, { recursive: true });
    fs.writeFileSync(fx.layout.projectDirectory(guid(1)), 'blocker');
    expect(await fx.repo.create({ name: 'Boom' })).toEqual({ ok: false, reason: 'io-failed' });
    expect(fs.existsSync(path.join(fx.root, 'Boom'))).toBe(false);
  });

  it('serializes concurrent creates: no duplicate name, no shared directory', async () => {
    fx = createProjectsFixture();
    const results = await Promise.all(
      ['Alpha', 'alpha', 'ALPHA', 'Beta', 'Gamma'].map((name) => fx.repo.create({ name })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.every((r) => r.ok || r.reason === 'name-taken')).toBe(true);
  });
});

describe('read-only while the storage is not ready', () => {
  it.each([
    [{ status: 'migrating' as const }, 'storage-migrating'],
    [{ status: 'error' as const, message: 'x' }, 'storage-error'],
    [{ status: 'newer' as const, found: 9, supported: 1 }, 'storage-newer'],
  ])('refuses every write with %j and writes nothing', async (state, reason) => {
    fx = createProjectsFixture();
    const project = must(await fx.repo.create({ name: 'Existing' }));
    const before = tree(fx.dir);
    fx.setState(state);
    expect(await fx.repo.create({ name: 'New' })).toEqual({ ok: false, reason });
    expect(await fx.repo.update(project.id, { pinned: true })).toEqual({ ok: false, reason });
    expect(await fx.repo.delete(project.id)).toEqual({ ok: false, reason });
    expect(tree(fx.dir)).toEqual(before);
    expect(fs.existsSync(path.join(fx.root, 'New'))).toBe(false);
    expect((await fx.repo.list()).projects).toHaveLength(1);
    expect(fx.repo.state()).toEqual(state);
    expect(await fx.repo.directoryOf(project.id)).toBeNull();
    expect(await fx.repo.directoryOf(null)).toBeNull();
  });
});

describe('list and get', () => {
  it('reports corrupt, newer and unsafe-dir projects instead of dropping them, and keeps the rest usable', async () => {
    fx = createProjectsFixture();
    must(await fx.repo.create({ name: 'Good' }));
    writeProjectJson(fx, guid(10), '{not json');
    writeProjectJson(fx, guid(11), {
      schemaVersion: 7,
      id: guid(11),
      name: 'From the future',
      dir: 'Future',
    });
    writeProjectJson(fx, guid(12), validRecord(guid(12), { dir: '../../outside' }));
    writeProjectJson(fx, guid(13), validRecord(guid(13), { dir: 'C:/Windows' }));
    writeProjectJson(fx, guid(14), validRecord(guid(14), { dir: 'con' }));
    writeProjectJson(fx, guid(15), validRecord(guid(15), { dir: '.vozella/projects' }));
    writeProjectJson(fx, guid(16), validRecord(guid(16), { id: guid(99) }));
    const listing = await fx.repo.list();
    expect(listing.projects.map((p) => p.name)).toEqual(['Good']);
    const byId = new Map(listing.skipped.map((s) => [s.id, s]));
    expect(byId.get(guid(10))).toMatchObject({ reason: 'corrupt', dir: null });
    expect(byId.get(guid(11))).toMatchObject({ reason: 'unsupported', dir: 'Future' });
    expect(byId.get(guid(12))).toMatchObject({ reason: 'unsafe-dir', dir: '../../outside' });
    expect(byId.get(guid(13))).toMatchObject({ reason: 'unsafe-dir' });
    expect(byId.get(guid(14))).toMatchObject({ reason: 'unsafe-dir' });
    expect(byId.get(guid(15))).toMatchObject({ reason: 'unsafe-dir' });
    expect(byId.get(guid(16))).toMatchObject({ reason: 'corrupt' });
    expect(await fx.repo.get(guid(12))).toBeNull();
    // Never deleted.
    expect(fs.existsSync(fx.layout.projectJsonFile(guid(10)))).toBe(true);
  });

  it('answers null for an id that is not a canonical GUID, without touching the disk', async () => {
    fx = createProjectsFixture();
    expect(await fx.repo.get('../evil')).toBeNull();
    expect(await fx.repo.get(guid(1).toUpperCase())).toBeNull();
  });

  it('reads a file with a BOM and CRLF that a person edited by hand', async () => {
    fx = createProjectsFixture();
    const text = JSON.stringify(validRecord(guid(20), { name: 'Edited' }), null, 2).replace(
      /\n/g,
      '\r\n',
    );
    writeProjectJson(fx, guid(20), `\uFEFF${text}`);
    expect((await fx.repo.get(guid(20)))?.name).toBe('Edited');
  });
});

describe('update', () => {
  it('renames without touching the directory, which stays frozen', async () => {
    fx = createProjectsFixture();
    const project = must(await fx.repo.create({ name: 'Old' }));
    const renamed = must(await fx.repo.update(project.id, { name: 'New name' }));
    expect(renamed.name).toBe('New name');
    expect(fs.existsSync(path.join(fx.root, 'Old'))).toBe(true);
    expect(await fx.repo.directoryOf(project.id)).toBe(path.join(fx.root, 'Old'));
    expect(renamed.updatedAt > project.updatedAt).toBe(true);
  });

  it('keeps unknown keys through a read-modify-write', async () => {
    fx = createProjectsFixture();
    writeProjectJson(
      fx,
      guid(30),
      validRecord(guid(30), {
        futureThing: { a: [1, 2] },
        origin: { kind: 'folder', parentId: null, originalName: 'x', extra: 1 },
      }),
    );
    must(await fx.repo.update(guid(30), { pinned: true, instructions: 'Hola' }));
    const back = readProjectJson(fx, guid(30));
    expect(back.futureThing).toEqual({ a: [1, 2] });
    expect(back.origin).toEqual({ kind: 'folder', parentId: null, originalName: 'x', extra: 1 });
    expect(back).toMatchObject({ pinned: true, instructions: 'Hola', dir: 'Hand made' });
  });

  it('does not rewrite the file when nothing changes', async () => {
    fx = createProjectsFixture();
    const project = must(await fx.repo.create({ name: 'Same' }));
    const file = fx.layout.projectJsonFile(project.id);
    const before = fs.statSync(file).mtimeMs;
    must(await fx.repo.update(project.id, { name: 'Same', pinned: false }));
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('validates names and sizes and refuses unknown, newer and corrupt projects', async () => {
    fx = createProjectsFixture();
    const a = must(await fx.repo.create({ name: 'A' }));
    must(await fx.repo.create({ name: 'B' }));
    writeProjectJson(fx, guid(40), { schemaVersion: 5, id: guid(40), name: 'N', dir: 'N' });
    writeProjectJson(fx, guid(41), '{broken');
    expect(await fx.repo.update(a.id, { name: 'b' })).toEqual({ ok: false, reason: 'name-taken' });
    expect(await fx.repo.update(a.id, { name: ' ' })).toEqual({ ok: false, reason: 'empty-name' });
    expect(await fx.repo.update(a.id, { instructions: 'x'.repeat(20_001) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(await fx.repo.update(guid(99), { pinned: true })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await fx.repo.update(guid(40), { pinned: true })).toEqual({
      ok: false,
      reason: 'storage-newer',
    });
    expect(await fx.repo.update(guid(41), { pinned: true })).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(readProjectJson(fx, guid(40)).schemaVersion).toBe(5);
  });

  it('concurrent updates of different fields all land', async () => {
    fx = createProjectsFixture();
    const p = must(await fx.repo.create({ name: 'Race' }));
    await Promise.all([
      fx.repo.update(p.id, { description: 'd' }),
      fx.repo.update(p.id, { instructions: 'i' }),
      fx.repo.update(p.id, { pinned: true }),
      fx.repo.update(p.id, { name: 'Race 2' }),
    ]);
    expect(await fx.repo.get(p.id)).toMatchObject({
      description: 'd',
      instructions: 'i',
      pinned: true,
      name: 'Race 2',
    });
    expect(tree(fx.dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('directoryOf', () => {
  it('answers the Inbox for no project and for an unknown id, and the frozen directory otherwise', async () => {
    fx = createProjectsFixture();
    const p = must(await fx.repo.create({ name: 'Trabajo' }));
    expect(await fx.repo.directoryOf(null)).toBe(path.join(fx.root, 'Inbox'));
    expect(await fx.repo.directoryOf(guid(77))).toBe(path.join(fx.root, 'Inbox'));
    expect(await fx.repo.directoryOf('not-a-guid')).toBe(path.join(fx.root, 'Inbox'));
    expect(await fx.repo.directoryOf(p.id)).toBe(path.join(fx.root, 'Trabajo'));
  });

  it('answers null when the project cannot be placed: unsafe, newer or corrupt', async () => {
    fx = createProjectsFixture();
    writeProjectJson(fx, guid(70), validRecord(guid(70), { dir: '../x' }));
    writeProjectJson(fx, guid(71), { schemaVersion: 4, id: guid(71), dir: 'ok' });
    writeProjectJson(fx, guid(72), '{');
    for (const n of [70, 71, 72]) expect(await fx.repo.directoryOf(guid(n))).toBeNull();
  });

  it('resolves a nested migrated directory inside the Library', async () => {
    fx = createProjectsFixture();
    writeProjectJson(fx, guid(73), validRecord(guid(73), { dir: 'Universidad/Cálculo' }));
    expect(await fx.repo.directoryOf(guid(73))).toBe(path.join(fx.root, 'Universidad', 'Cálculo'));
  });
});

describe('delete', () => {
  it('discards only .vozella/projects/<id> and leaves the meeting directory and its files', async () => {
    fx = createProjectsFixture();
    const p = must(await fx.repo.create({ name: 'Trabajo' }));
    fs.writeFileSync(path.join(fx.root, 'Trabajo', 'meeting.md'), 'x');
    must(await fx.repo.delete(p.id));
    expect(fx.discarded).toEqual([fx.layout.projectDirectory(p.id)]);
    expect(fs.existsSync(fx.layout.projectDirectory(p.id))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'Trabajo', 'meeting.md'))).toBe(true);
    expect(await fx.repo.get(p.id)).toBeNull();
  });

  it('removes the now empty meeting directory, non-recursively', async () => {
    fx = createProjectsFixture();
    const p = must(await fx.repo.create({ name: 'Empty' }));
    must(await fx.repo.delete(p.id));
    expect(fs.existsSync(path.join(fx.root, 'Empty'))).toBe(false);
  });

  it('keeps a directory that contains another project directory, and the child project', async () => {
    fx = createProjectsFixture();
    writeProjectJson(
      fx,
      guid(80),
      validRecord(guid(80), { name: 'Universidad', dir: 'Universidad' }),
    );
    writeProjectJson(
      fx,
      guid(81),
      validRecord(guid(81), { name: 'Universidad – Cálculo', dir: 'Universidad/Cálculo' }),
    );
    fs.mkdirSync(path.join(fx.root, 'Universidad', 'Cálculo'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, 'Universidad', 'Cálculo', 'm.md'), 'x');
    must(await fx.repo.delete(guid(80)));
    expect(fs.existsSync(path.join(fx.root, 'Universidad', 'Cálculo', 'm.md'))).toBe(true);
    expect(await fx.repo.get(guid(81))).not.toBeNull();
  });

  it('keeps a directory another project shares', async () => {
    fx = createProjectsFixture();
    writeProjectJson(fx, guid(82), validRecord(guid(82), { name: 'A', dir: 'Shared' }));
    writeProjectJson(fx, guid(83), validRecord(guid(83), { name: 'B', dir: 'Shared' }));
    fs.mkdirSync(path.join(fx.root, 'Shared'));
    must(await fx.repo.delete(guid(82)));
    expect(fs.existsSync(path.join(fx.root, 'Shared'))).toBe(true);
  });

  it('answers trash-failed when the discard fails, and keeps the project', async () => {
    fx = createProjectsFixture({ discard: () => Promise.reject(new Error('bin refused')) });
    const p = must(await fx.repo.create({ name: 'Stay' }));
    expect(await fx.repo.delete(p.id)).toEqual({ ok: false, reason: 'trash-failed' });
    expect(await fx.repo.get(p.id)).not.toBeNull();
  });

  it('refuses to delete a corrupt or unsafe project, and keeps its files and chats on disk', async () => {
    fx = createProjectsFixture();
    fs.mkdirSync(fx.layout.projectDirectory(guid(85)), { recursive: true });
    fs.writeFileSync(fx.layout.projectJsonFile(guid(85)), '{ not json');
    fs.mkdirSync(path.join(fx.layout.projectDirectory(guid(85)), 'chats'));
    writeProjectJson(fx, guid(86), validRecord(guid(86), { dir: '../../outside' }));
    expect(await fx.repo.delete(guid(85))).toEqual({ ok: false, reason: 'corrupt' });
    expect(await fx.repo.delete(guid(86))).toEqual({ ok: false, reason: 'corrupt' });
    expect(fx.discarded).toEqual([]);
    expect(fs.existsSync(path.join(fx.layout.projectDirectory(guid(85)), 'chats'))).toBe(true);
    expect(fs.existsSync(fx.layout.projectJsonFile(guid(86)))).toBe(true);
  });

  it('answers not-found for an unknown id and storage-newer for a newer project', async () => {
    fx = createProjectsFixture();
    writeProjectJson(fx, guid(84), { schemaVersion: 8, id: guid(84), dir: 'X' });
    expect(await fx.repo.delete(guid(99))).toEqual({ ok: false, reason: 'not-found' });
    expect(await fx.repo.delete('../..')).toEqual({ ok: false, reason: 'not-found' });
    expect(await fx.repo.delete(guid(84))).toEqual({ ok: false, reason: 'storage-newer' });
    expect(fs.existsSync(fx.layout.projectJsonFile(guid(84)))).toBe(true);
  });
});
