import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  PROJECT_FILE_MAX_FILES,
  createStorageLayout,
  type Logger,
  type StorageLayout,
  type StorageState,
} from '@vozella/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDocument } from '../chat/attachment-extractors';
import { buildDocx, buildPdf, buildPptx } from '../chat/attachment-fixtures';
import { listMarkdownFiles } from '../library/library-layout';
import { createProjectFileStore, type ProjectFileStoreDeps } from './project-file-store';
import { StorageStateHolder } from './storage-state';

const PROJECT = '9f1c0000-0000-4000-8000-000000000001';
const OTHER = '9f1c0000-0000-4000-8000-000000000002';
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let dir: string;
let root: string;
let src: string;
let layout: StorageLayout;
let state: StorageStateHolder;
let counter: number;
let clockMs: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-pfs-'));
  root = path.join(dir, 'library');
  src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  layout = createStorageLayout(root, path);
  state = new StorageStateHolder({ status: 'ready' });
  counter = 0;
  clockMs = Date.parse('2026-11-16T10:00:00.000Z');
  for (const id of [PROJECT, OTHER]) {
    fs.mkdirSync(layout.projectDirectory(id), { recursive: true });
    fs.writeFileSync(layout.projectJsonFile(id), '{}');
  }
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const source = (name: string, data: string | Uint8Array): string => {
  const file = path.join(src, name);
  fs.writeFileSync(file, data);
  return file;
};

function store(over: Partial<ProjectFileStoreDeps> = {}) {
  return createProjectFileStore({
    layout,
    extractor: extractDocument,
    state,
    logger: silent,
    clock: {
      now: () => {
        clockMs += 1_000;
        return new Date(clockMs);
      },
    },
    newId: () => `aaaaaaaa-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    ...over,
  });
}

const readJson = (target: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;

const fileDirs = (project = PROJECT): string[] =>
  fs.existsSync(layout.filesDirectory(project))
    ? fs.readdirSync(layout.filesDirectory(project))
    : [];

describe('add: accepted files', () => {
  it('copies the bytes and extracts a text file', async () => {
    const file = source('Notes.md', '# Syllabus\nWeek 1');
    const result = await store().add(PROJECT, file);
    expect(result).toMatchObject({
      ok: true,
      file: { name: 'Notes.md', kind: 'text', sizeBytes: 17, pages: null, truncated: false },
    });
    if (!result.ok) return;
    const id = result.file.id;
    const meta = readJson(path.join(layout.fileDirectory(PROJECT, id), 'meta.json'));
    expect(meta).toMatchObject({ schemaVersion: 1, id, name: 'Notes.md', textChars: 17 });
    expect(meta.sha256).toBe(createHash('sha256').update('# Syllabus\nWeek 1').digest('hex'));
    const extracted = readJson(path.join(layout.fileDirectory(PROJECT, id), 'extracted.json'));
    expect(extracted.sections).toEqual([{ location: null, text: '# Syllabus\nWeek 1' }]);
    const stored = fs
      .readdirSync(layout.fileDirectory(PROJECT, id))
      .filter((n) => n.startsWith('original'));
    expect(stored).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(layout.fileDirectory(PROJECT, id), stored[0] ?? ''), 'utf8'),
    ).toBe('# Syllabus\nWeek 1');
  });

  it.each([
    ['a.txt', 'plain', 'text'],
    ['b.csv', 'a,b\n1,2', 'text'],
  ] as const)('%s', async (name, body, kind) => {
    const result = await store().add(PROJECT, source(name, body));
    expect(result).toMatchObject({ ok: true, file: { name, kind } });
  });

  it('extracts a pdf with its pages', async () => {
    const result = await store().add(PROJECT, source('a.pdf', buildPdf(['one', 'two'])));
    expect(result).toMatchObject({ ok: true, file: { kind: 'pdf', pages: 2 } });
  });

  it('extracts a docx', async () => {
    const result = await store().add(PROJECT, source('a.docx', await buildDocx(['hello docx'])));
    expect(result).toMatchObject({ ok: true, file: { kind: 'docx' } });
    expect((await store().readDocuments(PROJECT))[0]?.sections[0]?.text).toContain('hello docx');
  });

  it('extracts a pptx with its slides', async () => {
    const result = await store().add(PROJECT, source('a.pptx', await buildPptx([['s1'], ['s2']])));
    expect(result).toMatchObject({ ok: true, file: { kind: 'pptx', pages: 2 } });
  });

  it('keeps a .md context file out of the meeting scan', async () => {
    await store().add(PROJECT, source('Notes.md', '---\nId: x\n---\n# a meeting?'));
    expect(await listMarkdownFiles(root)).toEqual([]);
  });
});

describe('add: refusals', () => {
  it('refuses an image, an unknown type and a missing file', async () => {
    expect(await store().add(PROJECT, source('a.png', 'x'))).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(await store().add(PROJECT, source('a.exe', 'x'))).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(await store().add(PROJECT, path.join(src, 'missing.txt'))).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses a relative path, a UNC path and a device path', async () => {
    for (const bad of [
      'notes.txt',
      '\\\\server\\share\\a.txt',
      '//server/share/a.txt',
      '\\\\?\\C:\\a.txt',
    ]) {
      expect(await store().add(PROJECT, bad)).toMatchObject({ ok: false, reason: 'not-found' });
    }
  });

  it('refuses a directory', async () => {
    const folder = path.join(src, 'folder.txt');
    fs.mkdirSync(folder);
    expect(await store().add(PROJECT, folder)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('refuses a file over the size limit', async () => {
    const big = source('big.txt', Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 97));
    expect(await store().add(PROJECT, big)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(fileDirs()).toEqual([]);
  });

  it('reports an encrypted office file, a file without text and an unreadable one', async () => {
    const cfb = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(await store().add(PROJECT, source('enc.docx', cfb))).toMatchObject({
      ok: false,
      reason: 'encrypted',
    });
    expect(await store().add(PROJECT, source('blank.txt', '   \n '))).toMatchObject({
      ok: false,
      reason: 'no-text',
    });
    expect(await store().add(PROJECT, source('broken.pdf', 'not a pdf'))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    });
    expect(fileDirs()).toEqual([]);
  });

  it('refuses the same bytes under another name', async () => {
    await store().add(PROJECT, source('one.txt', 'same'));
    expect(await store().add(PROJECT, source('two.txt', 'same'))).toEqual({
      ok: false,
      name: 'two.txt',
      reason: 'duplicate',
    });
    expect(await store().add(OTHER, source('three.txt', 'same'))).toMatchObject({ ok: true });
  });

  it('refuses the file past the file-count limit', async () => {
    const s = store();
    for (let i = 0; i < PROJECT_FILE_MAX_FILES; i += 1) {
      expect(await s.add(PROJECT, source(`f${String(i)}.txt`, `body ${String(i)}`))).toMatchObject({
        ok: true,
      });
    }
    expect(await s.add(PROJECT, source('extra.txt', 'one more'))).toMatchObject({
      ok: false,
      reason: 'project-full',
    });
  });

  it('refuses the file that would pass the total text limit', async () => {
    const s = store();
    for (let i = 0; i < 5; i += 1) {
      const text = String(i).repeat(200_000);
      expect(await s.add(PROJECT, source(`big${String(i)}.txt`, text))).toMatchObject({ ok: true });
    }
    expect(await s.add(PROJECT, source('last.txt', 'x'))).toMatchObject({
      ok: false,
      reason: 'project-full',
    });
  });

  it('refuses an unknown project and an id that is not a GUID', async () => {
    const file = source('a.txt', 'hello');
    expect(await store().add('9f1c0000-0000-4000-8000-0000000000ff', file)).toMatchObject({
      ok: false,
      reason: 'not-a-project',
    });
    expect(await store().add('..', file)).toMatchObject({ ok: false, reason: 'not-a-project' });
  });
});

describe('storage state', () => {
  it.each<[StorageState, string]>([
    [{ status: 'migrating' }, 'storage-migrating'],
    [{ status: 'error', message: 'boom' }, 'storage-error'],
    [{ status: 'newer', found: 2, supported: 1 }, 'storage-newer'],
  ])('refuses writes while %j', async (next, reason) => {
    const s = store();
    const added = await s.add(PROJECT, source('a.txt', 'hello'));
    expect(added.ok).toBe(true);
    state.set(next);
    expect(await s.add(PROJECT, source('b.txt', 'other'))).toMatchObject({ ok: false, reason });
    if (added.ok) expect(await s.remove(PROJECT, added.file.id)).toBe(false);
    expect(await s.list(PROJECT)).toHaveLength(1);
    expect(fileDirs()).toHaveLength(1);
  });
});

describe('list, aborted adds and remove', () => {
  it('does not list an aborted add (no meta.json) and cleans it up', async () => {
    const s = store();
    await s.add(PROJECT, source('a.txt', 'kept'));
    const aborted = path.join(
      layout.filesDirectory(PROJECT),
      'bbbbbbbb-0000-4000-8000-000000000001',
    );
    fs.mkdirSync(aborted, { recursive: true });
    fs.writeFileSync(path.join(aborted, 'original.txt'), 'half');
    expect((await s.list(PROJECT)).map((f) => f.name)).toEqual(['a.txt']);
    expect(fs.existsSync(aborted)).toBe(false);
  });

  it('leaves an aborted add alone while the storage is not ready', async () => {
    const aborted = path.join(
      layout.filesDirectory(PROJECT),
      'bbbbbbbb-0000-4000-8000-000000000001',
    );
    fs.mkdirSync(aborted, { recursive: true });
    state.set({ status: 'newer', found: 2, supported: 1 });
    expect(await store().list(PROJECT)).toEqual([]);
    expect(fs.existsSync(aborted)).toBe(true);
  });

  it('writes meta.json last: a failing extraction leaves nothing behind', async () => {
    const s = store({
      extractor: () => Promise.reject(new Error('worker died')),
    });
    expect(await s.add(PROJECT, source('a.pdf', buildPdf(['x'])))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    });
    expect(fileDirs()).toEqual([]);
  });

  it('remove deletes the directory and answers false for an unknown id', async () => {
    const s = store();
    const added = await s.add(PROJECT, source('a.txt', 'hello'));
    if (!added.ok) throw new Error('add failed');
    expect(await s.remove(PROJECT, added.file.id)).toBe(true);
    expect(fileDirs()).toEqual([]);
    expect(await s.remove(PROJECT, added.file.id)).toBe(false);
    expect(await s.remove(PROJECT, 'not-a-guid')).toBe(false);
  });

  it('remove hands the directory to the injected discard', async () => {
    const discarded: string[] = [];
    const s = store({
      discard: (target) => {
        discarded.push(target);
        fs.rmSync(target, { recursive: true });
        return Promise.resolve();
      },
    });
    const added = await s.add(PROJECT, source('a.txt', 'hello'));
    if (!added.ok) throw new Error('add failed');
    expect(await s.remove(PROJECT, added.file.id)).toBe(true);
    expect(discarded).toEqual([layout.fileDirectory(PROJECT, added.file.id)]);
  });

  it('keeps the files when discard fails', async () => {
    const s = store({ discard: () => Promise.reject(new Error('locked')) });
    const added = await s.add(PROJECT, source('a.txt', 'hello'));
    if (!added.ok) throw new Error('add failed');
    expect(await s.remove(PROJECT, added.file.id)).toBe(false);
    expect(await s.list(PROJECT)).toHaveLength(1);
  });

  it('counts the files of every project', async () => {
    const s = store();
    await s.add(PROJECT, source('a.txt', 'a'));
    await s.add(PROJECT, source('b.txt', 'b'));
    await s.add(OTHER, source('c.txt', 'c'));
    expect(await s.countByProject()).toEqual(
      new Map([
        [PROJECT, 2],
        [OTHER, 1],
      ]),
    );
  });
});

describe('versions and unknown keys', () => {
  const metaPath = (id: string, project = PROJECT): string =>
    path.join(layout.fileDirectory(project, id), 'meta.json');

  it('lists a file written by a newer version as unsupported and never touches it', async () => {
    const s = store();
    const added = await s.add(PROJECT, source('a.txt', 'hello'));
    if (!added.ok) throw new Error('add failed');
    const meta = readJson(metaPath(added.file.id));
    fs.writeFileSync(metaPath(added.file.id), JSON.stringify({ ...meta, schemaVersion: 2 }));
    const before = fs.readFileSync(metaPath(added.file.id), 'utf8');
    expect(await s.list(PROJECT)).toEqual([]);
    expect(await s.readDocuments(PROJECT)).toEqual([]);
    expect(await s.skipped(PROJECT)).toEqual([{ id: added.file.id, reason: 'unsupported' }]);
    expect(await s.remove(PROJECT, added.file.id)).toBe(false);
    expect(fs.readFileSync(metaPath(added.file.id), 'utf8')).toBe(before);
    expect(await s.countByProject()).toEqual(new Map([[PROJECT, 1]]));
  });

  it('reports a corrupt meta as corrupt and keeps listing the rest', async () => {
    const s = store();
    const bad = await s.add(PROJECT, source('a.txt', 'one'));
    await s.add(PROJECT, source('b.txt', 'two'));
    if (!bad.ok) throw new Error('add failed');
    fs.writeFileSync(metaPath(bad.file.id), '{ nope');
    expect((await s.list(PROJECT)).map((f) => f.name)).toEqual(['b.txt']);
    expect(await s.skipped(PROJECT)).toEqual([{ id: bad.file.id, reason: 'corrupt' }]);
    expect(fs.existsSync(layout.fileDirectory(PROJECT, bad.file.id))).toBe(true);
  });

  it('lists a meta with an unknown key and leaves its bytes alone when others change', async () => {
    const s = store();
    const first = await s.add(PROJECT, source('a.txt', 'one'));
    if (!first.ok) throw new Error('add failed');
    const meta = readJson(metaPath(first.file.id));
    const withExtra = JSON.stringify({ ...meta, futureField: { keep: true } });
    fs.writeFileSync(metaPath(first.file.id), withExtra);
    const second = await s.add(PROJECT, source('b.txt', 'two'));
    if (!second.ok) throw new Error('add failed');
    await s.remove(PROJECT, second.file.id);
    expect((await s.list(PROJECT)).map((f) => f.name)).toEqual(['a.txt']);
    expect(fs.readFileSync(metaPath(first.file.id), 'utf8')).toBe(withExtra);
  });
});

describe('readDocuments', () => {
  it('returns the documents ordered by addedAt', async () => {
    const s = store();
    await s.add(PROJECT, source('z-first.txt', 'first'));
    await s.add(PROJECT, source('a-second.txt', 'second'));
    const docs = await s.readDocuments(PROJECT);
    expect(docs.map((d) => d.name)).toEqual(['z-first.txt', 'a-second.txt']);
    expect(docs[0]).toMatchObject({ kind: 'text', pages: null, truncated: false });
    expect(docs[0]?.sections).toEqual([{ location: null, text: 'first' }]);
  });

  it('keeps page tags', async () => {
    await store().add(PROJECT, source('a.pdf', buildPdf(['alpha', 'beta'])));
    const [doc] = await store().readDocuments(PROJECT);
    expect(doc?.sections.map((x) => x.location)).toEqual([
      { kind: 'page', n: 1 },
      { kind: 'page', n: 2 },
    ]);
  });

  it('is empty for a project without files or an invalid id', async () => {
    expect(await store().readDocuments(OTHER)).toEqual([]);
    expect(await store().readDocuments('nope')).toEqual([]);
  });

  it('follows add and remove', async () => {
    const s = store();
    const a = await s.add(PROJECT, source('a.txt', 'one'));
    expect(await s.readDocuments(PROJECT)).toHaveLength(1);
    const b = await s.add(PROJECT, source('b.txt', 'two'));
    expect(await s.readDocuments(PROJECT)).toHaveLength(2);
    if (a.ok) await s.remove(PROJECT, a.file.id);
    expect((await s.readDocuments(PROJECT)).map((d) => d.name)).toEqual(['b.txt']);
    expect(b.ok).toBe(true);
  });

  it('serves the cache while the extracted file is unchanged and reloads when it changes', async () => {
    const s = store();
    const added = await s.add(PROJECT, source('a.txt', 'before'));
    if (!added.ok) throw new Error('add failed');
    const extracted = path.join(layout.fileDirectory(PROJECT, added.file.id), 'extracted.json');
    expect((await s.readDocuments(PROJECT))[0]?.sections[0]?.text).toBe('before');
    const stat = fs.statSync(extracted);
    const rewrite = (text: string): void => {
      const body = readJson(extracted);
      body.sections = [{ location: null, text }];
      fs.writeFileSync(extracted, JSON.stringify(body));
    };
    rewrite('after!');
    fs.utimesSync(extracted, stat.atime, stat.mtime);
    if (fs.statSync(extracted).size === stat.size) {
      expect((await s.readDocuments(PROJECT))[0]?.sections[0]?.text).toBe('before');
    }
    rewrite('changed later');
    fs.utimesSync(extracted, new Date(), new Date(Date.now() + 5_000));
    expect((await s.readDocuments(PROJECT))[0]?.sections[0]?.text).toBe('changed later');
  });

  it('leaves out a file whose extracted text is damaged', async () => {
    const s = store();
    const bad = await s.add(PROJECT, source('a.txt', 'one'));
    await s.add(PROJECT, source('b.txt', 'two'));
    if (!bad.ok) throw new Error('add failed');
    fs.writeFileSync(
      path.join(layout.fileDirectory(PROJECT, bad.file.id), 'extracted.json'),
      'garbage',
    );
    expect((await s.readDocuments(PROJECT)).map((d) => d.name)).toEqual(['b.txt']);
  });
});
