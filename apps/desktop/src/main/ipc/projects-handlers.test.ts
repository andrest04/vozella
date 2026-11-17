import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventChannel } from '@vozella/contracts';
import {
  projectsCreate,
  projectsDelete,
  projectsGet,
  projectsList,
  projectsMigrationReport,
} from '@vozella/contracts';
import { MeetingBusyRegistry, Workspace, renderMeetingMarkdown, type Logger } from '@vozella/core';
import { FakeClock, LibraryRuntime, type StorageMigration } from '@vozella/platform';
import type { IpcEventLike } from '../security/trusted-origin';
import type { WindowDialogs } from '../window-dialogs';
import type { IpcMainLike } from './ipc-server';
import { registerProjectHandlers } from './projects-handlers';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};
const MEETING = '11111111-1111-1111-1111-111111111111';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-projects-handlers-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: { code: string };
}

async function setup(
  options: { migrations?: StorageMigration[]; before?: (meetingsRoot: string) => void } = {},
) {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const busy = new MeetingBusyRegistry();
  const meetingsRoot = path.join(dir, 'meetings');
  options.before?.(meetingsRoot);
  const runtime = new LibraryRuntime({
    mode: 'test',
    roots: { appData: path.join(dir, 'app'), meetings: meetingsRoot, source: 'env' },
    guard: {
      localAppData: path.join(dir, 'fake-local'),
      documents: path.join(dir, 'fake-docs'),
      tempDir: os.tmpdir(),
    },
    logger: logger(),
    clock: new FakeClock('2026-09-05T15:00:00Z'),
    newId: () => crypto.randomUUID(),
    busy,
    extractor: () => Promise.resolve({ ok: false, reason: 'unreadable' }),
    openPath: () => Promise.resolve(''),
    pickFolder: () => Promise.resolve(null),
    version: '1.0.0.0',
    ...(options.migrations ? { migrations: options.migrations } : {}),
  });
  await runtime.start();
  const workspace = new Workspace();
  const events: { name: string; payload: unknown }[] = [];
  const broadcast = (channel: EventChannel, payload: unknown) => {
    events.push({ name: channel.name, payload });
  };
  registerProjectHandlers({
    server: { ipc, isTrusted: () => true, logger: logger() },
    library: runtime,
    workspace,
    broadcast,
    dialogs: {} as WindowDialogs,
    logger: logger(),
  });
  const call = async (name: string, input: unknown = {}): Promise<Answer> =>
    (await handlers.get(name)?.(event as never, input)) as Answer;
  return { call, runtime, workspace, events, meetingsRoot, busy };
}

describe('project channels', () => {
  it('registers exactly the project channels of the contract', async () => {
    const t = await setup();
    for (const channel of [
      projectsList,
      projectsGet,
      projectsCreate,
      projectsDelete,
      projectsMigrationReport,
    ]) {
      expect(
        (
          await t.call(
            channel.name,
            channel.name === 'projects.get' || channel.name === 'projects.delete'
              ? { id: crypto.randomUUID() }
              : {},
          )
        ).error?.code,
      ).not.toBe('unknown-channel');
    }
  });

  it('creates, lists and gets a project, and announces the change to every window', async () => {
    const t = await setup();
    const created = await t.call('projects.create', { name: ' Cálculo ', description: 'Clases' });
    expect(created.value).toMatchObject({
      ok: true,
      project: { name: 'Cálculo', description: 'Clases', pinned: false },
    });
    const id = (created.value?.project as { id: string }).id;
    expect(t.events).toEqual([
      { name: 'projects.changed', payload: { reason: 'project', projectId: id } },
      { name: 'library.changed', payload: { reason: 'project' } },
    ]);
    expect((await t.call('projects.list')).value).toMatchObject({
      projects: [{ id, name: 'Cálculo', meetingCount: 0, fileCount: 0 }],
      noProject: { meetingCount: 0, lastActivityAt: null },
      skipped: [],
      storage: { status: 'ready' },
    });
    expect((await t.call('projects.get', { id })).value).toMatchObject({
      ok: true,
      project: { id },
      files: [],
    });
  });

  it('answers failures as values: name taken, empty, not found', async () => {
    const t = await setup();
    await t.call('projects.create', { name: 'A' });
    t.events.length = 0;
    expect((await t.call('projects.create', { name: 'a' })).value).toEqual({
      ok: false,
      reason: 'name-taken',
    });
    expect((await t.call('projects.create', { name: '  ' })).value).toEqual({
      ok: false,
      reason: 'empty-name',
    });
    expect((await t.call('projects.get', { id: crypto.randomUUID() })).value).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(t.events).toEqual([]);
  });

  it('refuses what the schema forbids before the controller sees it', async () => {
    const t = await setup();
    expect((await t.call('projects.get', { id: '../../etc' })).error?.code).toBe('invalid-input');
    expect((await t.call('projects.create', { name: 'x', parentId: null })).error?.code).toBe(
      'invalid-input',
    );
    expect(
      (await t.call('projects.update', { id: crypto.randomUUID(), colorKey: 'red' })).error?.code,
    ).toBe('invalid-input');
    expect(
      (
        await t.call('projects.setInstructions', {
          id: crypto.randomUUID(),
          instructions: 'x'.repeat(20_001),
        })
      ).error?.code,
    ).toBe('invalid-input');
  });

  it('updates the name, description and pin, and sets instructions', async () => {
    const t = await setup();
    const id = ((await t.call('projects.create', { name: 'A' })).value?.project as { id: string })
      .id;
    expect(
      (await t.call('projects.update', { id, name: 'B', description: 'd', pinned: true })).value,
    ).toMatchObject({ ok: true, project: { name: 'B', description: 'd', pinned: true } });
    expect(
      (await t.call('projects.setInstructions', { id, instructions: 'Usar tono formal' })).value,
    ).toMatchObject({ ok: true, project: { instructions: 'Usar tono formal' } });
    expect(
      (await t.call('projects.setInstructions', { id: crypto.randomUUID(), instructions: 'x' }))
        .value,
    ).toEqual({ ok: false, reason: 'not-found' });
  });

  it('delete moves the meetings to no project, clears the selected project and says so', async () => {
    const t = await setup();
    const id = (
      (await t.call('projects.create', { name: 'Trabajo' })).value?.project as { id: string }
    ).id;
    await t.runtime.meetings.save({ ...(await seedMeeting(t.runtime)), projectId: id });
    t.workspace.publishSelectedProject(id);
    t.events.length = 0;
    expect((await t.call('projects.delete', { id })).value).toEqual({ ok: true });
    expect(t.workspace.state.selectedProjectId).toBeNull();
    expect((await t.runtime.meetings.get(MEETING))?.projectId).toBeNull();
    expect(t.events.map((e) => e.name)).toEqual([
      'projects.changed',
      'library.changed',
      'library.changed',
    ]);
    expect((await t.call('projects.list')).value).toMatchObject({
      projects: [],
      noProject: { meetingCount: 1 },
    });
    expect((await t.call('projects.delete', { id })).value).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses to delete a project whose meeting is busy', async () => {
    const t = await setup();
    const id = (
      (await t.call('projects.create', { name: 'Trabajo' })).value?.project as { id: string }
    ).id;
    await t.runtime.meetings.save({ ...(await seedMeeting(t.runtime)), projectId: id });
    t.busy.register({ isBusy: (meetingId) => meetingId === MEETING });
    t.events.length = 0;
    expect((await t.call('projects.delete', { id })).value).toEqual({ ok: false, reason: 'busy' });
    expect((await t.runtime.meetings.get(MEETING))?.projectId).toBe(id);
    expect(t.events).toEqual([]);
  });

  it('refuses writes while the storage is not ready, as a value, and still lists', async () => {
    const failing: StorageMigration = {
      id: '001',
      toVersion: 1,
      run: () => Promise.reject(new Error('boom')),
    };
    const t = await setup({ migrations: [failing] });
    expect((await t.call('projects.create', { name: 'A' })).value).toEqual({
      ok: false,
      reason: 'storage-error',
    });
    expect((await t.call('projects.list')).value).toMatchObject({
      projects: [],
      storage: { status: 'error', message: 'boom' },
    });
  });

  it('shows the migration notice once, from a real migration, and dismisses it', async () => {
    const t = await setup({
      before: (root) => {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(
          path.join(root, 'folders.json'),
          JSON.stringify([
            {
              id: '7b7e0000-0000-4000-8000-000000000001',
              name: 'Universidad',
              parentId: null,
              createdAt: '2025-01-01T00:00:00Z',
            },
            {
              id: '7b7e0000-0000-4000-8000-000000000002',
              name: 'Universidad',
              parentId: '7b7e0000-0000-4000-8000-000000000001',
              createdAt: '2025-01-02T00:00:00Z',
            },
          ]),
        );
      },
    });
    const first = await t.call('projects.migrationReport');
    expect(first.value).toMatchObject({
      report: {
        kind: 'folders-to-projects',
        projects: 2,
        renamed: [{ from: 'Universidad', to: 'Universidad – Universidad' }],
        skipped: [],
        legacyLeftovers: [],
      },
    });
    expect((await t.call('projects.dismissMigrationReport')).value).toEqual({});
    expect((await t.call('projects.migrationReport')).value).toEqual({ report: null });
    const listed = (await t.call('projects.list')).value as { projects: { name: string }[] };
    expect(listed.projects.map((p) => p.name).sort()).toEqual([
      'Universidad',
      'Universidad – Universidad',
    ]);
  });
});

async function seedMeeting(runtime: LibraryRuntime) {
  const text = renderMeetingMarkdown({
    id: MEETING,
    title: 'Standup',
    recordedAt: '2026-09-01T12:00:00.000+00:00',
    endedAt: null,
    audioFilePath: '',
    sourcePath: null,
    projectId: null,
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
  const inbox = path.join(runtime.libraryRoot, 'Inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, '2026-09-01 Standup.md'), text);
  const record = await runtime.meetings.get(MEETING);
  if (record === null) throw new Error('seed failed');
  return record;
}
