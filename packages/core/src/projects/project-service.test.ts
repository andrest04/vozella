import { describe, expect, it, vi } from 'vitest';
import type { ChatThread } from '../chat/chat-thread';
import { InMemoryMeetingRepository } from '../library/in-memory-library';
import type { MeetingRecord } from '../library/meeting';
import { MeetingBusyRegistry } from '../library/ports';
import {
  InMemoryChatThreadRepository,
  InMemoryProjectFileStore,
  InMemoryProjectRepository,
  InMemoryStorageState,
} from './in-memory-projects';
import { ProjectService } from './project-service';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const meeting = (
  n: number,
  projectId: string | null,
  recordedAt = '2026-09-01T12:00:00.000+00:00',
): MeetingRecord => ({
  id: id(100 + n),
  title: `Meeting ${String(n)}`,
  recordedAt,
  endedAt: null,
  audioFilePath: '',
  sourcePath: null,
  projectId,
  summaryProvider: null,
  calendarEventId: null,
  calendarId: null,
  seriesId: null,
  joinUrl: null,
  noteTemplateId: null,
  attendees: [],
  brief: null,
  transcript: null,
  summary: null,
  actionItems: [],
  jevAnalysis: null,
  notes: null,
  followUp: null,
  projectPlan: null,
});

const thread = (n: number, owner: string | null, updatedAt: string): ChatThread => ({
  schemaVersion: 1,
  id: id(500 + n),
  ownerProjectId: owner,
  scope: { kind: 'AllMeetings', meetingId: null },
  title: 'T',
  createdAt: updatedAt,
  updatedAt,
  messages: [],
});

function setup() {
  let tick = 0;
  const now = (): string => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)).toISOString();
  const state = new InMemoryStorageState();
  const projects = new InMemoryProjectRepository({ state, now });
  const meetings = new InMemoryMeetingRepository();
  const files = new InMemoryProjectFileStore(state, now);
  const threads = new InMemoryChatThreadRepository(state);
  const busy = new MeetingBusyRegistry();
  const service = new ProjectService({ projects, meetings, files, threads, busy });
  return { state, projects, meetings, files, threads, busy, service };
}

const created = async (t: ReturnType<typeof setup>, name: string) => {
  const result = await t.service.create({ name });
  if (!result.ok) throw new Error(`setup: ${result.reason}`);
  return result.value;
};

describe('create', () => {
  it('trims the name and keeps the description', async () => {
    const t = setup();
    const result = await t.service.create({ name: '  Cálculo ', description: 'Clases' });
    expect(result).toMatchObject({
      ok: true,
      value: { name: 'Cálculo', description: 'Clases', pinned: false },
    });
  });

  it('refuses empty and too long names and a too long description', async () => {
    const t = setup();
    expect(await t.service.create({ name: '  ' })).toEqual({ ok: false, reason: 'empty-name' });
    expect(await t.service.create({ name: 'x'.repeat(121) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(await t.service.create({ name: 'ok', description: 'x'.repeat(501) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('refuses a name taken by folded text: case and accents do not count', async () => {
    const t = setup();
    await created(t, 'Cálculo');
    expect(await t.service.create({ name: 'CALCULO' })).toEqual({
      ok: false,
      reason: 'name-taken',
    });
    expect(await t.service.create({ name: ' calculo ' })).toEqual({
      ok: false,
      reason: 'name-taken',
    });
  });

  it('answers a storage refusal while the storage is not ready', async () => {
    const t = setup();
    t.state.set({ status: 'migrating' });
    expect(await t.service.create({ name: 'A' })).toEqual({
      ok: false,
      reason: 'storage-migrating',
    });
  });
});

describe('update and setInstructions', () => {
  it('renames, edits the description and pins', async () => {
    const t = setup();
    const p = await created(t, 'A');
    expect(
      await t.service.update(p.id, { name: 'B', description: 'd', pinned: true }),
    ).toMatchObject({
      ok: true,
      value: { name: 'B', description: 'd', pinned: true },
    });
  });

  it('allows a case-only rename of itself but not onto another project', async () => {
    const t = setup();
    const a = await created(t, 'trabajo');
    const b = await created(t, 'Otro');
    expect((await t.service.update(a.id, { name: 'Trabajo' })).ok).toBe(true);
    expect(await t.service.update(b.id, { name: 'TRABAJO' })).toEqual({
      ok: false,
      reason: 'name-taken',
    });
  });

  it('refuses an unknown project, an empty name and an over-long value', async () => {
    const t = setup();
    const a = await created(t, 'A');
    expect(await t.service.update(id(99), { pinned: true })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await t.service.update(a.id, { name: ' ' })).toEqual({
      ok: false,
      reason: 'empty-name',
    });
    expect(await t.service.update(a.id, { description: 'x'.repeat(501) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('does not let update change the instructions', async () => {
    const t = setup();
    const a = await created(t, 'A');
    await t.service.update(a.id, { instructions: 'sneaky' });
    expect((await t.projects.get(a.id))?.instructions).toBe('');
  });

  it('stores instructions up to 20,000 characters and refuses more', async () => {
    const t = setup();
    const a = await created(t, 'A');
    expect(await t.service.setInstructions(a.id, 'Resumir en español')).toMatchObject({
      ok: true,
      value: { instructions: 'Resumir en español' },
    });
    expect((await t.service.setInstructions(a.id, 'x'.repeat(20_000))).ok).toBe(true);
    expect(await t.service.setInstructions(a.id, 'x'.repeat(20_001))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(await t.service.setInstructions(id(99), 'x')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('get', () => {
  it('returns the project with its files, or not-found', async () => {
    const t = setup();
    const a = await created(t, 'A');
    t.files.registerSource('/x.txt', { name: 'x.txt', kind: 'text', sizeBytes: 3, text: 'abc' });
    await t.files.add(a.id, '/x.txt');
    const result = await t.service.get(a.id);
    expect(result.ok && result.value.files.map((f) => f.name)).toEqual(['x.txt']);
    expect(await t.service.get(id(9))).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('list', () => {
  it('counts meetings and files and computes the last activity as the newest of project, meetings and chats', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const b = await created(t, 'B');
    const c = await created(t, 'C');
    t.meetings.records.set(id(101), meeting(1, a.id, '2027-01-05T10:00:00.000-05:00'));
    t.meetings.records.set(id(102), meeting(2, a.id, '2027-01-02T10:00:00.000+00:00'));
    await t.threads.save(thread(1, b.id, '2027-03-01T00:00:00.000Z'));
    t.files.registerSource('/x', { name: 'x', kind: 'text', sizeBytes: 1, text: 'x' });
    await t.files.add(a.id, '/x');
    const listing = await t.service.list();
    const byName = new Map(listing.projects.map((p) => [p.name, p]));
    expect(byName.get('A')).toMatchObject({
      meetingCount: 2,
      fileCount: 1,
      lastActivityAt: '2027-01-05T15:00:00.000Z',
    });
    expect(byName.get('B')).toMatchObject({
      meetingCount: 0,
      fileCount: 0,
      lastActivityAt: '2027-03-01T00:00:00.000Z',
    });
    expect(byName.get('C')?.lastActivityAt).toBe(c.updatedAt);
    expect(byName.get('A')).not.toHaveProperty('instructions');
    expect(listing.storage).toEqual({ status: 'ready' });
  });

  it('keeps the project edit date when it is the newest', async () => {
    const t = setup();
    const a = await created(t, 'A');
    t.meetings.records.set(id(101), meeting(1, a.id, '2020-01-01T00:00:00.000+00:00'));
    const listing = await t.service.list();
    expect(listing.projects[0]?.lastActivityAt).toBe(a.updatedAt);
  });

  it('summarizes no project: unfiled meetings and meetings of an unknown project, with chats of no project', async () => {
    const t = setup();
    await created(t, 'A');
    t.meetings.records.set(id(101), meeting(1, null, '2026-05-01T00:00:00.000+00:00'));
    t.meetings.records.set(id(102), meeting(2, id(77), '2026-06-01T00:00:00.000+00:00'));
    t.meetings.records.set(id(103), meeting(3, null, '2026-04-01T00:00:00.000+00:00'));
    await t.threads.save(thread(1, null, '2026-07-01T00:00:00.000Z'));
    const listing = await t.service.list();
    expect(listing.noProject).toEqual({
      meetingCount: 3,
      lastActivityAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('answers no activity date when there is nothing', async () => {
    const t = setup();
    expect((await t.service.list()).noProject).toEqual({ meetingCount: 0, lastActivityAt: null });
  });

  it('reports skipped projects and the storage state', async () => {
    const t = setup();
    t.projects.skipped = [{ id: null, dir: 'X', reason: 'corrupt' }];
    t.state.set({ status: 'newer', found: 3, supported: 1 });
    const listing = await t.service.list();
    expect(listing.skipped).toEqual([{ id: null, dir: 'X', reason: 'corrupt' }]);
    expect(listing.storage).toEqual({ status: 'newer', found: 3, supported: 1 });
  });
});

describe('delete', () => {
  const fill = (t: ReturnType<typeof setup>, projectId: string, count: number): string[] => {
    const ids: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      const record = meeting(n, projectId);
      t.meetings.records.set(record.id, record);
      ids.push(record.id);
    }
    return ids;
  };

  it('moves the meetings to no project, then removes the project', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const ids = fill(t, a.id, 3);
    expect(await t.service.delete(a.id)).toEqual({ ok: true });
    for (const meetingId of ids) expect(t.meetings.records.get(meetingId)?.projectId).toBeNull();
    expect(await t.projects.get(a.id)).toBeNull();
  });

  it('leaves the meetings of another project alone', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const b = await created(t, 'B');
    fill(t, a.id, 1);
    const other = meeting(9, b.id);
    t.meetings.records.set(other.id, other);
    await t.service.delete(a.id);
    expect(t.meetings.records.get(other.id)?.projectId).toBe(b.id);
  });

  it('refuses while a meeting of the project is recording or processing, touching nothing', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const ids = fill(t, a.id, 2);
    t.busy.register({ isBusy: (meetingId) => meetingId === ids[1] });
    expect(await t.service.delete(a.id)).toEqual({ ok: false, reason: 'busy' });
    expect(t.meetings.records.get(ids[0] ?? '')?.projectId).toBe(a.id);
    expect(await t.projects.get(a.id)).not.toBeNull();
  });

  it('refuses an unknown project and a storage that is not ready, without moving meetings', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const [first] = fill(t, a.id, 1);
    expect(await t.service.delete(id(9))).toEqual({ ok: false, reason: 'not-found' });
    t.state.set({ status: 'error', message: 'x' });
    expect(await t.service.delete(a.id)).toEqual({ ok: false, reason: 'storage-error' });
    expect(t.meetings.records.get(first ?? '')?.projectId).toBe(a.id);
  });

  it('keeps the project and reports how far it got when a move fails', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const ids = fill(t, a.id, 4);
    const save = t.meetings.save.bind(t.meetings);
    t.meetings.save = (record) =>
      record.id === ids[1] || record.id === ids[2]
        ? Promise.reject(new Error('EBUSY: locked'))
        : save(record);
    expect(await t.service.delete(a.id)).toEqual({
      ok: false,
      reason: 'partial',
      moved: 2,
      remaining: 2,
    });
    expect(await t.projects.get(a.id)).not.toBeNull();
    expect(t.meetings.records.get(ids[0] ?? '')?.projectId).toBeNull();
    expect(t.meetings.records.get(ids[1] ?? '')?.projectId).toBe(a.id);
  });

  it('is resumable: running it again moves the rest and finishes', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const ids = fill(t, a.id, 3);
    const save = t.meetings.save.bind(t.meetings);
    t.meetings.save = (record) =>
      record.id === ids[2] ? Promise.reject(new Error('EBUSY: locked')) : save(record);
    expect(await t.service.delete(a.id)).toMatchObject({
      reason: 'partial',
      moved: 2,
      remaining: 1,
    });
    t.meetings.save = save;
    expect(await t.service.delete(a.id)).toEqual({ ok: true });
    expect([...t.meetings.records.values()].every((m) => m.projectId === null)).toBe(true);
    expect(await t.projects.get(a.id)).toBeNull();
  });

  it('survives a crash between two moves: the state is consistent and the same call finishes', async () => {
    const t = setup();
    const a = await created(t, 'A');
    fill(t, a.id, 3);
    let calls = 0;
    const save = t.meetings.save.bind(t.meetings);
    t.meetings.save = (record) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('process died')) : save(record);
    };
    const first = await t.service.delete(a.id);
    expect(first).toMatchObject({ ok: false, reason: 'partial', remaining: 1 });
    const stillThere = [...t.meetings.records.values()].filter((m) => m.projectId === a.id);
    expect(stillThere).toHaveLength(1);
    expect(await t.projects.get(a.id)).not.toBeNull();
    expect(await t.service.delete(a.id)).toEqual({ ok: true });
  });

  it('keeps the project if a meeting arrived while it was moving the others', async () => {
    const t = setup();
    const a = await created(t, 'A');
    const ids = fill(t, a.id, 1);
    const save = t.meetings.save.bind(t.meetings);
    t.meetings.save = async (record) => {
      const late = meeting(8, a.id);
      t.meetings.records.set(late.id, late);
      return save(record);
    };
    expect(ids).toHaveLength(1);
    expect(await t.service.delete(a.id)).toMatchObject({
      ok: false,
      reason: 'partial',
      moved: 1,
      remaining: 1,
    });
    expect(await t.projects.get(a.id)).not.toBeNull();
  });

  it('deleting a parent never touches the meetings of a project that was nested in it', async () => {
    const t = setup();
    const parent = await created(t, 'Universidad');
    const child = await created(t, 'Cálculo');
    const childMeeting = meeting(5, child.id);
    t.meetings.records.set(childMeeting.id, childMeeting);
    await t.service.delete(parent.id);
    expect(t.meetings.records.get(childMeeting.id)?.projectId).toBe(child.id);
    expect(await t.projects.get(child.id)).not.toBeNull();
  });

  it('runs the moves as one repository batch', async () => {
    const t = setup();
    const a = await created(t, 'A');
    fill(t, a.id, 2);
    const batch = vi.spyOn(t.meetings, 'batch');
    await t.service.delete(a.id);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('passes the failure of the storage delete on', async () => {
    const t = setup();
    const a = await created(t, 'A');
    t.projects.delete = () => Promise.resolve({ ok: false, reason: 'trash-failed' });
    expect(await t.service.delete(a.id)).toEqual({ ok: false, reason: 'trash-failed' });
  });
});
