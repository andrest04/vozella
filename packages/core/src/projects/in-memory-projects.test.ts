import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../chat/chat-thread';
import {
  InMemoryChatThreadRepository,
  InMemoryProjectContextSource,
  InMemoryProjectFileStore,
  InMemoryProjectRepository,
  InMemoryStorageState,
} from './in-memory-projects';

const thread = (id: string, owner: string | null, updatedAt: string): ChatThread => ({
  schemaVersion: 1,
  id,
  ownerProjectId: owner,
  scope: { kind: 'AllMeetings', meetingId: null },
  title: 'Hello',
  createdAt: updatedAt,
  updatedAt,
  messages: [{ id: 'm1', role: 'user', text: 'Hello', createdAt: updatedAt }],
});

describe('InMemoryProjectRepository', () => {
  it('creates, renames, pins and deletes a project', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ name: ' Calculus ', description: 'Notes' });
    if (!created.ok) throw new Error('create failed');
    expect(created.value).toMatchObject({ name: 'Calculus', description: 'Notes', pinned: false });
    const updated = await repo.update(created.value.id, { name: 'Algebra', pinned: true });
    expect(updated).toMatchObject({ ok: true, value: { name: 'Algebra', pinned: true } });
    expect(await repo.delete(created.value.id)).toEqual({ ok: true, value: undefined });
    expect(await repo.get(created.value.id)).toBeNull();
    expect(await repo.delete(created.value.id)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses an empty, a too long and a taken name (case and accents do not count)', async () => {
    const repo = new InMemoryProjectRepository();
    await repo.create({ name: 'Cálculo' });
    expect(await repo.create({ name: '  ' })).toEqual({ ok: false, reason: 'empty-name' });
    expect(await repo.create({ name: 'x'.repeat(121) })).toEqual({ ok: false, reason: 'too-long' });
    expect(await repo.create({ name: 'CALCULO' })).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('places meetings: Inbox for no project or an unknown one, null while not ready', async () => {
    const state = new InMemoryStorageState();
    const repo = new InMemoryProjectRepository({ state, libraryRoot: '/lib' });
    const created = await repo.create({ name: 'Work' });
    if (!created.ok) throw new Error('create failed');
    expect(await repo.directoryOf(created.value.id)).toBe('/lib/Work');
    expect(await repo.directoryOf(null)).toBe('/lib/Inbox');
    expect(await repo.directoryOf('unknown')).toBe('/lib/Inbox');
    state.set({ status: 'migrating' });
    expect(await repo.directoryOf(created.value.id)).toBeNull();
  });

  it.each([
    [{ status: 'migrating' }, 'storage-migrating'],
    [{ status: 'error', message: 'x' }, 'storage-error'],
    [{ status: 'newer', found: 2, supported: 1 }, 'storage-newer'],
  ] as const)('refuses every write while the state is %j', async (next, reason) => {
    const state = new InMemoryStorageState();
    const repo = new InMemoryProjectRepository({ state });
    const created = await repo.create({ name: 'Work' });
    if (!created.ok) throw new Error('create failed');
    state.set(next);
    expect(repo.state()).toEqual(next);
    expect(await repo.create({ name: 'Other' })).toEqual({ ok: false, reason });
    expect(await repo.update(created.value.id, { pinned: true })).toEqual({ ok: false, reason });
    expect(await repo.delete(created.value.id)).toEqual({ ok: false, reason });
    expect((await repo.list()).projects).toHaveLength(1);
  });
});

describe('InMemoryProjectFileStore', () => {
  it('adds a registered file, refuses a duplicate and a missing one, lists and removes', async () => {
    const files = new InMemoryProjectFileStore();
    files.registerSource('/in/a.txt', { name: 'a.txt', kind: 'text', sizeBytes: 5, text: 'hello' });
    const added = await files.add('p1', '/in/a.txt');
    if (!added.ok) throw new Error('add failed');
    expect(await files.add('p1', '/in/a.txt')).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(await files.add('p1', '/in/none.txt')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await files.list('p1')).toHaveLength(1);
    expect((await files.countByProject()).get('p1')).toBe(1);
    expect(await files.readDocuments('p1')).toEqual([
      {
        name: 'a.txt',
        kind: 'text',
        pages: null,
        truncated: false,
        sections: [{ location: null, text: 'hello' }],
      },
    ]);
    expect(await files.remove('p1', added.file.id)).toBe(true);
    expect(await files.remove('p1', added.file.id)).toBe(false);
  });

  it('refuses writes while the storage is not ready', async () => {
    const state = new InMemoryStorageState({ status: 'newer', found: 3, supported: 1 });
    const files = new InMemoryProjectFileStore(state);
    files.registerSource('/in/a.txt', { name: 'a.txt', kind: 'text', sizeBytes: 5, text: 'hello' });
    expect(await files.add('p1', '/in/a.txt')).toEqual({
      ok: false,
      name: 'a.txt',
      reason: 'storage-newer',
    });
  });
});

describe('InMemoryChatThreadRepository', () => {
  it('lists newest first per owner and reports the last activity of each', async () => {
    const threads = new InMemoryChatThreadRepository();
    await threads.save(thread('t1', 'p1', '2026-01-01T00:00:00.000Z'));
    await threads.save(thread('t2', 'p1', '2026-02-01T00:00:00.000Z'));
    await threads.save(thread('t3', null, '2026-03-01T00:00:00.000Z'));
    expect((await threads.list('p1')).map((t) => t.id)).toEqual(['t2', 't1']);
    expect((await threads.list(null)).map((t) => t.id)).toEqual(['t3']);
    const activity = await threads.activity();
    expect(activity.get('p1')).toBe('2026-02-01T00:00:00.000Z');
    expect(activity.get(null)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('renames and deletes, and refuses saves while the storage is read-only', async () => {
    const state = new InMemoryStorageState();
    const threads = new InMemoryChatThreadRepository(state);
    await threads.save(thread('t1', 'p1', '2026-01-01T00:00:00.000Z'));
    expect(await threads.rename('p1', 't1', 'New title')).toBe(true);
    expect((await threads.get('p1', 't1'))?.title).toBe('New title');
    state.set({ status: 'error', message: 'x' });
    expect(await threads.save(thread('t2', 'p1', '2026-01-02T00:00:00.000Z'))).toEqual({
      ok: false,
      reason: 'storage-error',
    });
    expect(await threads.delete('p1', 't1')).toBe(false);
    state.set({ status: 'ready' });
    expect(await threads.delete('p1', 't1')).toBe(true);
    expect(await threads.get('p1', 't1')).toBeNull();
  });
});

describe('InMemoryProjectContextSource', () => {
  it('answers null for an unknown project and the stored context for a known one', async () => {
    const source = new InMemoryProjectContextSource();
    source.set({ projectId: 'p1', name: 'Work', instructions: 'Be brief.', documents: [] });
    expect(await source.get('p1')).toMatchObject({ name: 'Work', instructions: 'Be brief.' });
    expect(await source.get('p2')).toBeNull();
  });
});
