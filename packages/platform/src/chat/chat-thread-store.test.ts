import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStorageLayout,
  type ChatThread,
  type LogContext,
  type Logger,
  type StorageLayout,
} from '@vozella/core';
import { FakeClock } from '../fakes/fake-clock';
import { StorageStateHolder } from '../projects/storage-state';
import { createChatThreadStore } from './chat-thread-store';

const PROJECT = '9f1c2d3e-0000-4000-8000-000000000001';
const OTHER = '9f1c2d3e-0000-4000-8000-000000000002';
const id = (n: number): string => `7a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class RecordingLogger implements Logger {
  readonly warnings: { message: string; context?: LogContext }[] = [];
  debug(): void {
    // not recorded
  }
  info(): void {
    // not recorded
  }
  warn(message: string, context?: LogContext): void {
    this.warnings.push({ message, ...(context === undefined ? {} : { context }) });
  }
  error(): void {
    // not recorded
  }
}

let root: string;
let layout: StorageLayout;
let state: StorageStateHolder;
let logger: RecordingLogger;
let clock: FakeClock;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-threads-'));
  layout = createStorageLayout(root, path);
  state = new StorageStateHolder({ status: 'ready' });
  logger = new RecordingLogger();
  clock = new FakeClock();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const store = (discard?: (p: string) => Promise<void>) =>
  createChatThreadStore({
    layout,
    state,
    logger,
    clock,
    ...(discard === undefined ? {} : { discard }),
  });

function thread(n: number, over: Partial<ChatThread> = {}): ChatThread {
  return {
    schemaVersion: 1,
    id: id(n),
    ownerProjectId: PROJECT,
    scope: { kind: 'Project', meetingId: null },
    title: `Thread ${n}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-01T00:00:0${n}.000Z`,
    messages: [
      { id: `m${n}a`, role: 'user', text: 'Hi', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: `m${n}b`, role: 'assistant', text: 'Hello', createdAt: '2026-01-01T00:00:01.000Z' },
    ],
    ...over,
  };
}

const fileOf = (owner: string | null, n: number): string => layout.threadFile(owner, id(n));
const readRaw = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('chat thread store: round trip', () => {
  it('saves a thread under the owner directory and reads it back', async () => {
    const s = store();
    expect(await s.save(thread(1))).toEqual({ ok: true, value: undefined });
    expect(fileOf(PROJECT, 1)).toBe(
      path.join(root, '.vozella', 'projects', PROJECT, 'chats', `${id(1)}.json`),
    );
    expect(await s.get(PROJECT, id(1))).toEqual(thread(1));
  });

  it('writes plain JSON: two-space indent, LF, trailing newline, no BOM', async () => {
    await store().save(thread(1));
    const text = fs.readFileSync(fileOf(PROJECT, 1), 'utf8');
    expect(text.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('keeps the threads of no project under no-project/chats', async () => {
    const s = store();
    await s.save(thread(1, { ownerProjectId: null }));
    expect(fileOf(null, 1)).toBe(
      path.join(root, '.vozella', 'no-project', 'chats', `${id(1)}.json`),
    );
    expect(fs.existsSync(fileOf(null, 1))).toBe(true);
    expect((await s.list(null)).map((t) => t.id)).toEqual([id(1)]);
    expect(await s.list(PROJECT)).toEqual([]);
  });

  it('answers null for an unknown thread, another owner, or an id that is not a guid', async () => {
    const s = store();
    await s.save(thread(1));
    expect(await s.get(PROJECT, id(2))).toBeNull();
    expect(await s.get(OTHER, id(1))).toBeNull();
    expect(await s.get(PROJECT, '../../etc/passwd')).toBeNull();
    expect(await s.rename(PROJECT, '..\\x', 'a')).toBe(false);
    expect(await s.delete(PROJECT, 'nope')).toBe(false);
  });

  it('refuses to save a thread whose id is not a guid, without writing', async () => {
    const result = await store().save(thread(1, { id: '../evil' }));
    expect(result).toEqual({ ok: false, reason: 'io-failed' });
    expect(fs.existsSync(path.join(root, '.vozella'))).toBe(false);
  });

  it('lists the newest first, with the message count and no messages', async () => {
    const s = store();
    await s.save(thread(1));
    await s.save(thread(3));
    await s.save(thread(2));
    const list = await s.list(PROJECT);
    expect(list.map((t) => t.id)).toEqual([id(3), id(2), id(1)]);
    expect(list[0]).toEqual({
      id: id(3),
      ownerProjectId: PROJECT,
      scope: { kind: 'Project', meetingId: null },
      title: 'Thread 3',
      updatedAt: '2026-01-01T00:00:03.000Z',
      messageCount: 2,
    });
  });

  it('answers an empty list when the chats directory does not exist', async () => {
    expect(await store().list(PROJECT)).toEqual([]);
    expect(await store().list(null)).toEqual([]);
  });
});

describe('chat thread store: the list header cache', () => {
  it('parses a file again only when its time or size changed', async () => {
    const s = store();
    await s.save(thread(1));
    await s.save(thread(2));
    const read = vi.spyOn(fsp, 'readFile');
    await s.list(PROJECT);
    expect(read).toHaveBeenCalledTimes(2);
    await s.list(PROJECT);
    expect(read).toHaveBeenCalledTimes(2);
    await s.save(thread(2, { title: 'Changed title', updatedAt: '2026-01-02T00:00:00.000Z' }));
    read.mockClear();
    const list = await s.list(PROJECT);
    expect(list[0]?.title).toBe('Changed title');
    expect(
      read.mock.calls.filter(([file]) => (file as string).endsWith(`${id(1)}.json`)),
    ).toHaveLength(0);
  });

  it('forgets a deleted file', async () => {
    const s = store();
    await s.save(thread(1));
    await s.list(PROJECT);
    fs.rmSync(fileOf(PROJECT, 1));
    expect(await s.list(PROJECT)).toEqual([]);
  });
});

describe('chat thread store: files it cannot use', () => {
  it('skips a corrupt file, reports it and never deletes it', async () => {
    const s = store();
    await s.save(thread(1));
    fs.writeFileSync(fileOf(PROJECT, 2), '{ not json');
    fs.writeFileSync(fileOf(PROJECT, 3), JSON.stringify({ schemaVersion: 1, id: id(3) }));
    fs.writeFileSync(path.join(layout.chatsDirectory(PROJECT), 'notes.txt'), 'ignore me');
    expect((await s.list(PROJECT)).map((t) => t.id)).toEqual([id(1)]);
    expect(await s.get(PROJECT, id(2))).toBeNull();
    expect(fs.readFileSync(fileOf(PROJECT, 2), 'utf8')).toBe('{ not json');
    expect(fs.existsSync(fileOf(PROJECT, 3))).toBe(true);
    expect(s.skipped(PROJECT)).toEqual(
      expect.arrayContaining([
        { id: id(2), reason: 'corrupt' },
        { id: id(3), reason: 'corrupt' },
      ]),
    );
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  it('does not log the same corrupt file on every list', async () => {
    const s = store();
    await s.save(thread(1));
    fs.writeFileSync(fileOf(PROJECT, 2), '{ not json');
    await s.list(PROJECT);
    const first = logger.warnings.length;
    await s.list(PROJECT);
    expect(logger.warnings).toHaveLength(first);
  });

  it('reports a newer thread version as unsupported, never writes to it and keeps it', async () => {
    const s = store();
    const future = JSON.stringify({ ...thread(1), schemaVersion: 2, shiny: true });
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(fileOf(PROJECT, 1), future);
    expect(await s.list(PROJECT)).toEqual([]);
    expect(s.skipped(PROJECT)).toEqual([{ id: id(1), reason: 'unsupported' }]);
    expect(await s.get(PROJECT, id(1))).toBeNull();
    expect(await s.save(thread(1))).toEqual({ ok: false, reason: 'storage-newer' });
    expect(await s.rename(PROJECT, id(1), 'x')).toBe(false);
    expect(await s.delete(PROJECT, id(1))).toBe(false);
    expect(fs.readFileSync(fileOf(PROJECT, 1), 'utf8')).toBe(future);
  });

  it('refuses to overwrite a corrupt file of the same id', async () => {
    const s = store();
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(fileOf(PROJECT, 1), '{ not json');
    expect(await s.save(thread(1))).toEqual({ ok: false, reason: 'corrupt' });
    expect(fs.readFileSync(fileOf(PROJECT, 1), 'utf8')).toBe('{ not json');
  });

  it('lets the user delete a corrupt file', async () => {
    const s = store();
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(fileOf(PROJECT, 1), '{ not json');
    expect(await s.delete(PROJECT, id(1))).toBe(true);
    expect(fs.existsSync(fileOf(PROJECT, 1))).toBe(false);
  });
});

describe('chat thread store: keys it does not know', () => {
  const withExtras = (): string =>
    JSON.stringify({
      ...thread(1),
      futureTop: { a: 1 },
      scope: { kind: 'Project', meetingId: null, futureScope: 'x' },
      messages: [{ ...thread(1).messages[0], futureMessage: 7 }, { ...thread(1).messages[1] }],
    });

  it('carries them through a save', async () => {
    const s = store();
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(fileOf(PROJECT, 1), withExtras());
    const next = thread(1, {
      messages: [
        ...thread(1).messages,
        { id: 'm1c', role: 'user', text: 'More', createdAt: '2026-01-01T00:00:02.000Z' },
      ],
    });
    expect((await s.save(next)).ok).toBe(true);
    const raw = readRaw(fileOf(PROJECT, 1));
    expect(raw.futureTop).toEqual({ a: 1 });
    expect((raw.scope as Record<string, unknown>).futureScope).toBe('x');
    const messages = raw.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(3);
    expect(messages[0]?.futureMessage).toBe(7);
    expect(messages[2]?.text).toBe('More');
  });

  it('carries them through a rename, and a rename changes only the title', async () => {
    const s = store();
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(fileOf(PROJECT, 1), withExtras());
    expect(await s.rename(PROJECT, id(1), 'Midterm')).toBe(true);
    expect(readRaw(fileOf(PROJECT, 1))).toEqual({ ...JSON.parse(withExtras()), title: 'Midterm' });
  });

  it('a rename of an unknown thread is false', async () => {
    expect(await store().rename(PROJECT, id(9), 'x')).toBe(false);
  });
});

describe('chat thread store: concurrent writes', () => {
  it('serializes saves of the same thread: the last one wins and the file stays whole', async () => {
    const s = store();
    const saves = Array.from({ length: 25 }, (_, i) =>
      s.save(
        thread(1, {
          title: `Save ${i}`,
          messages: Array.from({ length: i + 1 }, (_, k) => ({
            id: `m${k}`,
            role: 'user' as const,
            text: 'x'.repeat(2000),
            createdAt: '2026-01-01T00:00:00.000Z',
          })),
        }),
      ),
    );
    expect((await Promise.all(saves)).every((r) => r.ok)).toBe(true);
    const final = await s.get(PROJECT, id(1));
    expect(final?.title).toBe('Save 24');
    expect(final?.messages).toHaveLength(25);
    expect(fs.readdirSync(layout.chatsDirectory(PROJECT))).toEqual([`${id(1)}.json`]);
  });

  it('serializes a rename between two saves, so none is lost', async () => {
    const s = store();
    await s.save(thread(1));
    const results = await Promise.all([
      s.save(thread(1, { title: 'A' })),
      s.rename(PROJECT, id(1), 'B'),
    ]);
    expect(results[0]).toEqual({ ok: true, value: undefined });
    expect(results[1]).toBe(true);
    expect((await s.get(PROJECT, id(1)))?.title).toBe('B');
  });

  it('keeps two owners independent', async () => {
    const s = store();
    await Promise.all([
      s.save(thread(1)),
      s.save(thread(2, { ownerProjectId: OTHER })),
      s.save(thread(3, { ownerProjectId: null })),
    ]);
    expect((await s.list(PROJECT)).map((t) => t.id)).toEqual([id(1)]);
    expect((await s.list(OTHER)).map((t) => t.id)).toEqual([id(2)]);
    expect((await s.list(null)).map((t) => t.id)).toEqual([id(3)]);
  });
});

describe('chat thread store: activity', () => {
  it('is the newest updatedAt of every owner that has a thread', async () => {
    const s = store();
    await s.save(thread(1));
    await s.save(thread(5));
    await s.save(thread(2, { ownerProjectId: OTHER }));
    await s.save(thread(3, { ownerProjectId: null }));
    fs.mkdirSync(layout.chatsDirectory('9f1c2d3e-0000-4000-8000-000000000003'), {
      recursive: true,
    });
    const map = await s.activity();
    expect(new Map(map)).toEqual(
      new Map<string | null, string>([
        [PROJECT, '2026-01-01T00:00:05.000Z'],
        [OTHER, '2026-01-01T00:00:02.000Z'],
        [null, '2026-01-01T00:00:03.000Z'],
      ]),
    );
  });

  it('is empty before any thread, and ignores directories that are not project ids', async () => {
    fs.mkdirSync(path.join(layout.projectsDirectory, 'not-a-guid', 'chats'), { recursive: true });
    expect((await store().activity()).size).toBe(0);
  });
});

describe('chat thread store: delete', () => {
  it('removes the file and the thread leaves the list', async () => {
    const s = store();
    await s.save(thread(1));
    expect(await s.delete(PROJECT, id(1))).toBe(true);
    expect(fs.existsSync(fileOf(PROJECT, 1))).toBe(false);
    expect(await s.list(PROJECT)).toEqual([]);
    expect(await s.delete(PROJECT, id(1))).toBe(false);
  });

  it('hands the file to the injected discard (Recycle Bin) when there is one', async () => {
    const discarded: string[] = [];
    const s = store((file) => {
      discarded.push(file);
      fs.rmSync(file);
      return Promise.resolve();
    });
    await s.save(thread(1));
    expect(await s.delete(PROJECT, id(1))).toBe(true);
    expect(discarded).toEqual([fileOf(PROJECT, 1)]);
  });

  it('answers false and keeps the file when the discard fails', async () => {
    const s = store(() => Promise.reject(new Error('locked')));
    await s.save(thread(1));
    expect(await s.delete(PROJECT, id(1))).toBe(false);
    expect(fs.existsSync(fileOf(PROJECT, 1))).toBe(true);
  });
});

describe('chat thread store: storage state', () => {
  it.each([
    [{ status: 'migrating' } as const, 'storage-migrating'],
    [{ status: 'error', message: 'x' } as const, 'storage-error'],
    [{ status: 'newer', found: 3, supported: 1 } as const, 'storage-newer'],
  ])('refuses every write while the storage is %j', async (next, reason) => {
    const s = store();
    await s.save(thread(1));
    const before = fs.readFileSync(fileOf(PROJECT, 1), 'utf8');
    state.set(next);
    expect(await s.save(thread(1, { title: 'Nope' }))).toEqual({ ok: false, reason });
    expect(await s.save(thread(2))).toEqual({ ok: false, reason });
    expect(await s.rename(PROJECT, id(1), 'Nope')).toBe(false);
    expect(await s.delete(PROJECT, id(1))).toBe(false);
    expect(fs.readFileSync(fileOf(PROJECT, 1), 'utf8')).toBe(before);
    expect(fs.existsSync(fileOf(PROJECT, 2))).toBe(false);
  });

  it('still reads while the storage is read-only, and writes again once ready', async () => {
    const s = store();
    await s.save(thread(1));
    state.set({ status: 'migrating' });
    expect((await s.list(PROJECT)).map((t) => t.id)).toEqual([id(1)]);
    expect((await s.get(PROJECT, id(1)))?.title).toBe('Thread 1');
    state.set({ status: 'ready' });
    expect((await s.save(thread(2))).ok).toBe(true);
  });

  it('reports a failed write as io-failed and leaves no temp file', async () => {
    const s = store();
    fs.mkdirSync(layout.chatsDirectory(PROJECT), { recursive: true });
    fs.mkdirSync(fileOf(PROJECT, 1)); // a directory where the file should go
    const result = await s.save(thread(1));
    expect(result.ok).toBe(false);
    expect(
      fs.readdirSync(layout.chatsDirectory(PROJECT)).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });
});
