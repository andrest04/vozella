import { describe, expect, it, vi } from 'vitest';
import { InMemoryProjectRepository, InMemoryStorageState } from '../projects/in-memory-projects';
import type { Project } from '../projects/project';
import { InMemoryMeetingRepository } from './in-memory-library';
import { LibraryService } from './library-service';
import type { MeetingRecord } from './meeting';
import { MeetingBusyRegistry } from './ports';

const meeting = (id: string, projectId: string | null = null, title = id): MeetingRecord => ({
  id,
  title,
  recordedAt: '2026-09-01T12:00:00.000+00:00',
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

function setup() {
  const meetings = new InMemoryMeetingRepository();
  const state = new InMemoryStorageState();
  const projects = new InMemoryProjectRepository({ state });
  const busy = new MeetingBusyRegistry();
  const service = new LibraryService({ meetings, projects, busy });
  /** Registers a project the library should know, under the given id. */
  const addProject = (id: string, name = id): void => {
    const project: Project = {
      id,
      name,
      description: '',
      instructions: '',
      pinned: false,
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    projects.records.set(id, project);
  };
  return { meetings, projects, state, busy, service, addProject };
}

describe('moveMeeting', () => {
  it('re-saves the full record with the new project, also when it is the same project', async () => {
    const t = setup();
    t.addProject('a');
    t.meetings.records.set('m', { ...meeting('m'), transcript: 'keep me' });
    const result = await t.service.moveMeeting({ meetingId: 'm', projectId: 'a' });
    expect(result).toMatchObject({ ok: true });
    expect(t.meetings.records.get('m')).toMatchObject({ projectId: 'a', transcript: 'keep me' });
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: 'a' })).toMatchObject({
      ok: true,
    });
  });

  it('moves to no project with a null project id', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m', 'a'));
    await t.service.moveMeeting({ meetingId: 'm', projectId: null });
    expect(t.meetings.records.get('m')?.projectId).toBeNull();
  });

  it('refuses a meeting that is being recorded or processed', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.busy.register({ isBusy: (id) => id === 'm' });
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: null })).toMatchObject({
      ok: false,
      reason: 'busy',
    });
  });

  it('refuses while the storage is not ready, for a project and for none', async () => {
    const t = setup();
    t.addProject('a');
    t.meetings.records.set('m', meeting('m'));
    t.state.set({ status: 'migrating' });
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: 'a' })).toEqual({
      ok: false,
      reason: 'storage-migrating',
    });
    t.state.set({ status: 'error', message: 'x' });
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: null })).toEqual({
      ok: false,
      reason: 'storage-error',
    });
    t.state.set({ status: 'newer', found: 9, supported: 1 });
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: null })).toEqual({
      ok: false,
      reason: 'storage-newer',
    });
    expect(t.meetings.records.get('m')?.projectId).toBeNull();
  });

  it('reports an unknown meeting or destination, and save failures', async () => {
    const t = setup();
    t.addProject('a');
    expect(await t.service.moveMeeting({ meetingId: 'zz', projectId: null })).toMatchObject({
      reason: 'not-found',
    });
    t.meetings.records.set('m', meeting('m'));
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: 'zz' })).toMatchObject({
      reason: 'not-found',
    });
    t.meetings.save = () => Promise.reject(new Error('EBUSY: locked'));
    expect(await t.service.moveMeeting({ meetingId: 'm', projectId: 'a' })).toMatchObject({
      ok: false,
      reason: 'io-failed',
      message: 'EBUSY: locked',
    });
  });
});

describe('deleteMeeting', () => {
  it('deletes and reports success', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    expect(await t.service.deleteMeeting('m')).toEqual({ ok: true });
    expect(t.meetings.records.size).toBe(0);
  });

  it('refuses a busy meeting before touching anything', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.busy.register({ isBusy: () => true });
    expect(await t.service.deleteMeeting('m')).toMatchObject({ ok: false, reason: 'busy' });
    expect(t.meetings.records.size).toBe(1);
  });

  it('a locked file is an io failure with the message, and the meeting stays', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.meetings.lockedIds.add('m');
    expect(await t.service.deleteMeeting('m')).toEqual({
      ok: false,
      reason: 'io-failed',
      message: 'EBUSY: resource busy or locked',
    });
    expect(t.meetings.records.size).toBe(1);
  });

  it('an unknown id succeeds without error', async () => {
    expect(await setup().service.deleteMeeting('zz')).toEqual({ ok: true });
  });

  it('says so when the Recycle Bin refused, and the meeting stays', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.meetings.trashRefusedIds.add('m');
    expect(await t.service.deleteMeeting('m')).toMatchObject({
      ok: false,
      reason: 'trash-failed',
    });
    expect(t.meetings.records.size).toBe(1);
  });

  it('a permanent delete does not depend on the Recycle Bin', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.meetings.trashRefusedIds.add('m');
    expect(await t.service.deleteMeeting('m', 'permanent')).toEqual({ ok: true });
    expect(t.meetings.records.size).toBe(0);
  });
});

describe('search', () => {
  const seeded = () => {
    const t = setup();
    t.addProject('a');
    t.meetings.records.set('in', { ...meeting('in'), notes: 'presupuesto del año' });
    t.meetings.records.set('lost', { ...meeting('lost', 'gone'), notes: 'presupuesto' });
    t.meetings.records.set('filed', { ...meeting('filed', 'a'), notes: 'presupuesto' });
    return t;
  };
  const ids = (result: { hits: readonly { meetingId: string }[] }): string[] =>
    result.hits.map((hit) => hit.meetingId).sort();

  it('searches the view it is given and echoes the request', async () => {
    const t = seeded();
    const search = (scope: Parameters<typeof t.service.search>[0]['scope']) =>
      t.service.search({ query: 'presupuesto', scope, requestId: 7 });
    expect(await search({ kind: 'all' })).toMatchObject({ requestId: 7, stale: false });
    expect(ids(await search({ kind: 'all' }))).toEqual(['filed', 'in', 'lost']);
    expect(ids(await search({ kind: 'none' }))).toEqual(['in', 'lost']);
    expect(ids(await search({ kind: 'project', id: 'a' }))).toEqual(['filed']);
  });

  it('abandons a search when a newer one arrives', async () => {
    const t = seeded();
    const first = t.service.search({ query: 'presupuesto', scope: { kind: 'all' }, requestId: 1 });
    const second = t.service.search({ query: 'presupuesto', scope: { kind: 'all' }, requestId: 2 });
    expect(await first).toEqual({ requestId: 1, stale: true, hits: [] });
    expect(await second).toMatchObject({ requestId: 2, stale: false });
    expect(ids(await second)).toEqual(['filed', 'in', 'lost']);
  });

  it('projects that cannot be listed leave every meeting in the no-project view', async () => {
    const t = seeded();
    t.projects.list = () => Promise.reject(new Error('unreadable'));
    const result = await t.service.search({
      query: 'presupuesto',
      scope: { kind: 'none' },
      requestId: 1,
    });
    expect(ids(result)).toEqual(['filed', 'in', 'lost']);
  });
});

describe('moveMeetings', () => {
  it('moves each meeting and reports each one, without stopping at a failure', async () => {
    const t = setup();
    t.addProject('a');
    t.meetings.records.set('m', meeting('m'));
    t.meetings.records.set('b', meeting('b'));
    t.meetings.records.set('n', meeting('n'));
    t.busy.register({ isBusy: (id) => id === 'b' });
    expect(
      await t.service.moveMeetings({ meetingIds: ['m', 'b', 'gone', 'n'], projectId: 'a' }),
    ).toEqual([
      { meetingId: 'm', ok: true },
      { meetingId: 'b', ok: false, reason: 'busy' },
      { meetingId: 'gone', ok: false, reason: 'not-found' },
      { meetingId: 'n', ok: true },
    ]);
    expect(t.meetings.records.get('m')?.projectId).toBe('a');
    expect(t.meetings.records.get('b')?.projectId).toBeNull();
    expect(t.meetings.records.get('n')?.projectId).toBe('a');
  });

  it('runs the whole batch as one repository batch', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    const batch = vi.spyOn(t.meetings, 'batch');
    await t.service.moveMeetings({ meetingIds: ['m'], projectId: null });
    await t.service.deleteMeetings({ meetingIds: ['m'], mode: 'trash' });
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('reports one result for an id named twice', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m', 'a'));
    expect(await t.service.moveMeetings({ meetingIds: ['m', 'm'], projectId: null })).toEqual([
      { meetingId: 'm', ok: true },
    ]);
  });
});

describe('deleteMeetings', () => {
  it('deletes each meeting and reports each one, without stopping at a failure', async () => {
    const t = setup();
    t.meetings.records.set('m', meeting('m'));
    t.meetings.records.set('l', meeting('l'));
    t.meetings.records.set('t', meeting('t'));
    t.meetings.records.set('n', meeting('n'));
    t.meetings.lockedIds.add('l');
    t.meetings.trashRefusedIds.add('t');
    expect(
      await t.service.deleteMeetings({ meetingIds: ['m', 'l', 't', 'n'], mode: 'trash' }),
    ).toEqual([
      { meetingId: 'm', ok: true },
      { meetingId: 'l', ok: false, reason: 'io-failed', message: 'EBUSY: resource busy or locked' },
      {
        meetingId: 't',
        ok: false,
        reason: 'trash-failed',
        message: 'The Recycle Bin refused the file.',
      },
      { meetingId: 'n', ok: true },
    ]);
    expect([...t.meetings.records.keys()]).toEqual(['l', 't']);
  });

  it('passes the mode on', async () => {
    const t = setup();
    t.meetings.records.set('t', meeting('t'));
    t.meetings.trashRefusedIds.add('t');
    expect(await t.service.deleteMeetings({ meetingIds: ['t'], mode: 'permanent' })).toEqual([
      { meetingId: 't', ok: true },
    ]);
  });
});

describe('load', () => {
  it('returns the light meeting list, the skipped files and the shadowed copies', async () => {
    const t = setup();
    t.addProject('a');
    t.meetings.records.set('m', { ...meeting('m', 'a'), summary: '# T\nBody text' });
    const result = await t.service.load();
    expect(result).toMatchObject({
      ok: true,
      meetings: [{ id: 'm', projectId: 'a', snippet: 'Body text' }],
      skipped: [],
      shadowed: [],
    });
    expect(result).not.toHaveProperty('folders');
  });

  it('tells the list how long a meeting ran, what it holds and whether it is busy', async () => {
    const t = setup();
    t.meetings.records.set('m', {
      ...meeting('m'),
      endedAt: '2026-09-01T12:45:00.000+00:00',
      summary: 'Body',
      transcript: '  ',
    });
    t.meetings.records.set('n', { ...meeting('n'), transcript: 'Spoken' });
    t.busy.register({ isBusy: (id) => id === 'n' });
    const result = await t.service.load();
    if (!result.ok) throw new Error('load failed');
    expect(result.meetings).toEqual([
      expect.objectContaining({
        id: 'm',
        endedAt: '2026-09-01T12:45:00.000+00:00',
        hasSummary: true,
        hasTranscript: false,
        busy: false,
      }),
      expect.objectContaining({
        id: 'n',
        endedAt: null,
        hasSummary: false,
        hasTranscript: true,
        busy: true,
      }),
    ]);
  });

  it('reports a repository failure instead of throwing', async () => {
    const t = setup();
    t.meetings.list = () => Promise.reject(new Error('EBUSY: locked'));
    expect(await t.service.load()).toMatchObject({ ok: false, reason: 'io-failed' });
  });
});
