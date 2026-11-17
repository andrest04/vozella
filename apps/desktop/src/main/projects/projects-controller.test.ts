import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryChatThreadRepository,
  InMemoryMeetingRepository,
  InMemoryProjectFileStore,
  InMemoryProjectRepository,
  InMemoryStorageState,
  MeetingBusyRegistry,
  ProjectService,
  Workspace,
  type Logger,
} from '@vozella/core';
import { createProjectsController, type ProjectsEvent } from './projects-controller';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup() {
  const state = new InMemoryStorageState();
  const projects = new InMemoryProjectRepository({ state });
  const meetings = new InMemoryMeetingRepository();
  const workspace = new Workspace();
  const events: ProjectsEvent[] = [];
  let notice: Awaited<ReturnType<ProjectService['migrationNotice']>> = null;
  const dismissed = vi.fn(() => {
    notice = null;
    return Promise.resolve();
  });
  const service = new ProjectService({
    projects,
    meetings,
    files: new InMemoryProjectFileStore(state),
    threads: new InMemoryChatThreadRepository(state),
    busy: new MeetingBusyRegistry(),
    notice: { read: () => Promise.resolve(notice), dismiss: dismissed },
  });
  const controller = createProjectsController({
    service,
    workspace,
    notify: (event) => events.push(event),
    logger,
  });
  return {
    controller,
    state,
    meetings,
    workspace,
    events,
    dismissed,
    setNotice: (n: typeof notice) => (notice = n),
  };
}

describe('projects controller', () => {
  it('creates, updates and sets instructions, announcing each change', async () => {
    const t = setup();
    const created = await t.controller.create({ name: 'Cálculo' });
    if (!created.ok) throw new Error('setup');
    const id = created.project.id;
    expect(await t.controller.update(id, { pinned: true })).toMatchObject({
      ok: true,
      project: { pinned: true },
    });
    expect(await t.controller.setInstructions(id, 'En español')).toMatchObject({
      ok: true,
      project: { instructions: 'En español' },
    });
    expect(t.events).toEqual([
      { kind: 'project', projectId: id },
      { kind: 'project', projectId: id },
      { kind: 'project', projectId: id },
    ]);
  });

  it('answers a failure as a value and announces nothing', async () => {
    const t = setup();
    await t.controller.create({ name: 'A' });
    t.events.length = 0;
    expect(await t.controller.create({ name: 'a' })).toEqual({ ok: false, reason: 'name-taken' });
    expect(await t.controller.create({ name: ' ' })).toEqual({ ok: false, reason: 'empty-name' });
    expect(
      await t.controller.update('00000000-0000-4000-8000-0000000000ff', { pinned: true }),
    ).toEqual({ ok: false, reason: 'not-found' });
    t.state.set({ status: 'newer', found: 3, supported: 1 });
    expect(await t.controller.create({ name: 'B' })).toEqual({
      ok: false,
      reason: 'storage-newer',
    });
    expect(t.events).toEqual([]);
  });

  it('lists with the storage state and gets a project with its files', async () => {
    const t = setup();
    const created = await t.controller.create({ name: 'A' });
    if (!created.ok) throw new Error('setup');
    expect(await t.controller.list()).toMatchObject({
      projects: [{ name: 'A', meetingCount: 0 }],
      noProject: { meetingCount: 0 },
      storage: { status: 'ready' },
      skipped: [],
    });
    expect(await t.controller.get(created.project.id)).toMatchObject({
      ok: true,
      project: { name: 'A' },
      files: [],
    });
    expect(await t.controller.get('00000000-0000-4000-8000-0000000000ff')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('delete success publishes a null selected project and tells the windows', async () => {
    const t = setup();
    const created = await t.controller.create({ name: 'A' });
    if (!created.ok) throw new Error('setup');
    const id = created.project.id;
    t.workspace.publishSelectedProject(id);
    t.events.length = 0;
    expect(await t.controller.delete(id)).toEqual({ ok: true });
    expect(t.workspace.state.selectedProjectId).toBeNull();
    expect(t.events).toEqual([{ kind: 'project', projectId: id }, { kind: 'meetings' }]);
  });

  it('a failed delete keeps the selection; a partial one still says meetings moved', async () => {
    const t = setup();
    const created = await t.controller.create({ name: 'A' });
    if (!created.ok) throw new Error('setup');
    const id = created.project.id;
    t.workspace.publishSelectedProject(id);
    t.meetings.records.set('m1', {
      id: 'm1',
      title: 'x',
      recordedAt: '2026-09-01T12:00:00.000+00:00',
      endedAt: null,
      audioFilePath: '',
      sourcePath: null,
      projectId: id,
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
    t.meetings.records.set('m2', { ...t.meetings.records.get('m1')!, id: 'm2' });
    const save = t.meetings.save.bind(t.meetings);
    t.meetings.save = (record) =>
      record.id === 'm2' ? Promise.reject(new Error('locked')) : save(record);
    t.events.length = 0;
    expect(await t.controller.delete(id)).toEqual({
      ok: false,
      reason: 'partial',
      moved: 1,
      remaining: 1,
    });
    expect(t.workspace.state.selectedProjectId).toBe(id);
    expect(t.events).toEqual([{ kind: 'meetings' }]);
    t.events.length = 0;
    expect(await t.controller.delete('00000000-0000-4000-8000-0000000000ff')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(t.events).toEqual([]);
  });

  it('reports and dismisses the migration notice', async () => {
    const t = setup();
    expect(await t.controller.migrationReport()).toEqual({ report: null });
    t.setNotice({
      kind: 'folders-to-projects',
      projects: 3,
      renamed: [{ id: '00000000-0000-4000-8000-000000000001', from: 'a', to: 'P – a' }],
      skipped: [{ index: 1, reason: 'invalid-id' }],
      legacyLeftovers: ['Meetings'],
    });
    expect(await t.controller.migrationReport()).toEqual({
      report: {
        kind: 'folders-to-projects',
        projects: 3,
        renamed: [{ id: '00000000-0000-4000-8000-000000000001', from: 'a', to: 'P – a' }],
        skipped: [{ index: 1, reason: 'invalid-id' }],
        legacyLeftovers: ['Meetings'],
      },
    });
    expect(await t.controller.dismissMigrationReport()).toEqual({});
    expect(t.dismissed).toHaveBeenCalledOnce();
    expect(await t.controller.migrationReport()).toEqual({ report: null });
  });
});
