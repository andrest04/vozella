import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventChannel } from '@vozella/contracts';
import { MeetingBusyRegistry, Workspace, type Logger, type MeetingRecord } from '@vozella/core';
import { FakeClock, LibraryRuntime, type StorageMigration } from '@vozella/platform';
import type { IpcEventLike } from '../security/trusted-origin';
import type { IpcMainLike } from './ipc-server';
import { applyWorkspaceAction, bridgeWorkspace, registerLibraryHandlers } from './library-handlers';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};
const ID = '11111111-1111-1111-1111-111111111111';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-handlers-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const record = (id: string = ID, title = 'Standup'): MeetingRecord => ({
  id,
  title,
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

async function setup(
  options: {
    discard?: (path: string) => Promise<void>;
    migrations?: StorageMigration[];
    onSettingsSaved?: (patch: Record<string, unknown>) => void;
  } = {},
) {
  const { onSettingsSaved, ...runtimeOptions } = options;
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const busy = new MeetingBusyRegistry();
  const runtime = new LibraryRuntime({
    mode: 'test',
    roots: { appData: path.join(dir, 'app'), meetings: path.join(dir, 'meetings'), source: 'env' },
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
    ...runtimeOptions,
  });
  await runtime.start();
  const workspace = new Workspace();
  const events: { name: string; payload: unknown }[] = [];
  const broadcast = (channel: EventChannel, payload: unknown) => {
    events.push({ name: channel.name, payload });
  };
  const writes = registerLibraryHandlers({
    server: { ipc, isTrusted: () => true, logger: logger() },
    runtime,
    workspace,
    broadcast,
    ...(onSettingsSaved ? { onSettingsSaved } : {}),
  });
  bridgeWorkspace(workspace, broadcast);
  const call = async (name: string, input: unknown = {}) =>
    (await handlers.get(name)?.(event as never, input)) as {
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string };
    };
  return { call, events, workspace, busy, runtime, writes };
}

describe('bulk meeting handlers', () => {
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const count = (t: Awaited<ReturnType<typeof setup>>, name: string): number =>
    t.events.filter((e) => e.name === name).length;

  it('moves several meetings with one library change and reports each one', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    await t.runtime.meetings.save(record(OTHER, 'Other'));
    const created = await t.runtime.projectService.create({ name: 'Trabajo' });
    const projectId = created.ok ? created.value.id : '';
    t.events.length = 0;
    t.busy.register({ isBusy: (id) => id === OTHER });

    const moved = await t.call('library.moveMeetings', { meetingIds: [ID, OTHER], projectId });

    expect(moved.value).toEqual({
      results: [
        { meetingId: ID, ok: true },
        { meetingId: OTHER, ok: false, reason: 'busy' },
      ],
    });
    expect(count(t, 'library.changed')).toBe(1);
    expect(t.events.filter((e) => e.name === 'workspace.meetingChanged')).toEqual([
      { name: 'workspace.meetingChanged', payload: { id: ID } },
    ]);
    expect((await t.runtime.meetings.get(ID))?.projectId).toBe(projectId);
  });

  it('deletes several meetings with one library change and one deleted notice per meeting', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    await t.runtime.meetings.save(record(OTHER, 'Other'));
    t.workspace.selectMeeting(OTHER);
    t.events.length = 0;

    const deleted = await t.call('library.deleteMeetings', {
      meetingIds: [ID, OTHER],
      mode: 'permanent',
    });

    expect(deleted.value).toEqual({
      results: [
        { meetingId: ID, ok: true },
        { meetingId: OTHER, ok: true },
      ],
    });
    expect(count(t, 'library.changed')).toBe(1);
    expect(count(t, 'workspace.meetingDeleted')).toBe(2);
    expect(t.workspace.state.selectedMeetingId).toBeNull();
  });

  it('stays quiet when nothing changed', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    t.busy.register({ isBusy: () => true });
    t.events.length = 0;
    await t.call('library.deleteMeetings', { meetingIds: [ID], mode: 'trash' });
    await t.call('library.moveMeetings', { meetingIds: [ID], projectId: null });
    expect(t.events).toEqual([]);
  });

  it('refuses an empty list at the boundary', async () => {
    const t = await setup();
    expect(await t.call('library.deleteMeetings', { meetingIds: [], mode: 'trash' })).toMatchObject(
      { ok: false },
    );
  });

  it('a quit waits for a bulk write in flight', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    const run = t.call('library.deleteMeetings', { meetingIds: [ID], mode: 'permanent' });
    await t.writes.settled();
    expect(await t.runtime.meetings.get(ID)).toBeNull();
    await run;
  });
});

describe('library.search', () => {
  it('finds a word in a body across the boundary', async () => {
    const t = await setup();
    await t.runtime.meetings.save({ ...record(), transcript: '[00:01.00-00:02.00] el año fiscal' });
    const found = await t.call('library.search', {
      query: 'ano',
      scope: { kind: 'all' },
      requestId: 3,
    });
    expect(found.value).toEqual({
      requestId: 3,
      stale: false,
      hits: [{ meetingId: ID, field: 'transcript', snippet: 'el año fiscal' }],
    });
  });

  it('refuses a scope it does not know', async () => {
    const t = await setup();
    expect(
      await t.call('library.search', { query: 'ano', scope: { kind: 'nope' }, requestId: 3 }),
    ).toMatchObject({ ok: false });
  });
});

describe('library handlers', () => {
  it('reports a meeting the Recycle Bin refused and leaves it listed', async () => {
    const t = await setup({
      discard: () => Promise.reject(new Error('no bin on this volume')),
    });
    await t.runtime.meetings.save(record());
    expect(await t.call('library.deleteMeeting', { meetingId: ID })).toMatchObject({
      value: { ok: false, reason: 'trash-failed' },
    });
    expect(t.events.map((e) => e.name)).not.toContain('library.changed');
    expect(
      await t.call('library.deleteMeeting', { meetingId: ID, mode: 'permanent' }),
    ).toMatchObject({ value: { ok: true } });
    expect(t.events.map((e) => e.name)).toContain('library.changed');
  });

  it('loads the meetings with no folders and an empty list of shadowed copies', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    const loaded = await t.call('library.load');
    expect(loaded.value).toMatchObject({
      ok: true,
      meetings: [{ id: ID }],
      skipped: [],
      shadowed: [],
    });
    expect(loaded.value).not.toHaveProperty('folders');
  });

  it('loads the duplicate-id copies as shadowed, with the newest kept', async () => {
    const t = await setup();
    const inbox = path.join(dir, 'meetings', 'Inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const { renderMeetingMarkdown } = await import('@vozella/core');
    const older = path.join(inbox, 'a.md');
    const newer = path.join(dir, 'meetings', 'Copy', 'b.md');
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(older, renderMeetingMarkdown(record(ID, 'Older')));
    fs.writeFileSync(newer, renderMeetingMarkdown(record(ID, 'Newer')));
    fs.utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(newer, new Date('2026-06-01'), new Date('2026-06-01'));
    const loaded = await t.call('library.load');
    expect(loaded.value).toMatchObject({
      ok: true,
      meetings: [{ id: ID, title: 'Newer' }],
      shadowed: [{ id: ID, keptPath: newer, shadowedPath: older }],
    });
  });

  it('refuses to move a meeting while the storage is not ready, and says why', async () => {
    const t = await setup({
      migrations: [{ id: '001', toVersion: 1, run: () => Promise.reject(new Error('boom')) }],
    });
    await t.runtime.meetings.save(record());
    const moved = await t.call('library.moveMeeting', { meetingId: ID, projectId: null });
    expect(moved.value).toEqual({ ok: false, reason: 'storage-error' });
    expect(t.events.filter((e) => e.name === 'library.changed')).toEqual([]);
  });

  it('lets a quit wait for a move that is still being written (B16)', async () => {
    const t = await setup();
    await t.runtime.meetings.save(record());
    const created = await t.runtime.projectService.create({ name: 'Trabajo' });
    const projectId = created.ok ? created.value.id : '';
    // Not awaited: the window is closing while the write is in flight.
    const inFlight = t.call('library.moveMeeting', { meetingId: ID, projectId });
    await t.writes.settled();
    expect((await t.runtime.meetings.get(ID))?.projectId).toBe(projectId);
    await inFlight;
    await expect(t.writes.settled()).resolves.toBeUndefined();
  });

  it('searches inside a project, inside no project, or everywhere', async () => {
    const t = await setup();
    const second = '22222222-2222-2222-2222-222222222222';
    const created = await t.runtime.projectService.create({ name: 'Trabajo' });
    const projectId = created.ok ? created.value.id : '';
    await t.runtime.meetings.save({ ...record(), summary: 'budget review' });
    await t.runtime.meetings.save({ ...record(second, 'Beta'), summary: 'budget plan', projectId });
    const found = async (scope: unknown) => {
      const answer = await t.call('library.search', { query: 'budget', scope, requestId: 1 });
      const hits = (answer.value as { hits: { meetingId: string }[] }).hits;
      return hits.map((hit) => hit.meetingId).sort();
    };
    expect(await found({ kind: 'all' })).toEqual([ID, second].sort());
    expect(await found({ kind: 'none' })).toEqual([ID]);
    expect(await found({ kind: 'project', id: projectId })).toEqual([second]);
    expect(
      (
        await t.call('library.search', {
          query: 'budget',
          scope: { kind: 'folder', id: projectId },
          requestId: 2,
        })
      ).ok,
    ).toBe(false);
  });

  it('broadcasts a call prompt offer to every window', async () => {
    const t = await setup();
    t.workspace.offerCallPrompt();
    expect(t.events.map((e) => e.name)).toContain('workspace.callPromptOffered');
  });

  it('moves and deletes a meeting, clears the workspace, and refuses busy ones', async () => {
    const t = await setup();
    const saved = await t.runtime.meetings.save({
      id: ID,
      title: 'Standup',
      recordedAt: '2026-09-01T12:00:00.0000000+00:00',
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
      transcript: 'hello',
      summary: null,
      actionItems: [],
      jevAnalysis: null,
      notes: null,
      followUp: null,
      projectPlan: null,
    });
    t.workspace.selectMeeting(ID);

    const full = await t.call('library.getMeeting', { id: ID });
    expect(full.value).toMatchObject({ record: { id: ID, transcript: 'hello' } });
    expect(
      await t.call('library.getMeeting', { id: '22222222-2222-2222-2222-222222222222' }),
    ).toMatchObject({
      value: { record: null },
    });

    const off = t.busy.register({ isBusy: (id) => id === ID });
    expect(await t.call('library.isMeetingBusy', { meetingId: ID })).toMatchObject({
      value: { busy: true },
    });
    expect(await t.call('library.deleteMeeting', { meetingId: ID })).toMatchObject({
      value: { ok: false, reason: 'busy' },
    });
    expect(fs.existsSync(saved.sourcePath ?? '')).toBe(true);
    off();

    expect(await t.call('library.deleteMeeting', { meetingId: ID })).toMatchObject({
      value: { ok: true },
    });
    expect(fs.existsSync(saved.sourcePath ?? '')).toBe(false);
    expect(t.workspace.state.selectedMeetingId).toBeNull();
    expect(t.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['workspace.meetingDeleted', 'library.changed', 'workspace.changed']),
    );
  });

  it('reads and patches settings, keeping other fields', async () => {
    const t = await setup();
    expect((await t.call('settings.get')).value).toMatchObject({
      meetingPopupEnabled: true,
      uiLanguage: null,
    });
    await t.call('settings.update', { patch: { uiLanguage: 'en' } });
    await t.call('settings.update', { patch: { summaryLanguage: 'en' } });
    expect((await t.call('settings.get')).value).toMatchObject({
      uiLanguage: 'en',
      summaryLanguage: 'en',
    });
    expect((await t.call('settings.update', { patch: { bogus: 1 } })).error?.code).toBe(
      'invalid-input',
    );
  });

  it('tells the app which fields a settings patch saved, and nothing for a refused patch', async () => {
    const saved = vi.fn();
    const t = await setup({ onSettingsSaved: saved });
    await t.call('settings.update', { patch: { transcriptionEngine: 'Groq' } });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenLastCalledWith({ transcriptionEngine: 'Groq' });
    await t.call('settings.update', { patch: { bogus: 1 } });
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('reports the location and refuses a MeetingLive folder in test mode', async () => {
    const t = await setup();
    expect((await t.call('library.getLocation')).value).toMatchObject({
      libraryRoot: path.join(dir, 'meetings'),
      appDataRoot: path.join(dir, 'app'),
      version: '1.0.0.0',
    });
    const refused = await t.call('library.setLocation', {
      path: path.join(dir, 'x', 'MeetingLive'),
    });
    expect(refused.value).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(await t.call('library.chooseLocation')).toMatchObject({
      value: { status: 'cancelled' },
    });
    expect(await t.call('library.openFolder')).toMatchObject({ value: { opened: true } });
  });
});

describe('workspace channels', () => {
  it('publishSelectedProject sets the selected project, null clears it, and every window hears it', async () => {
    const t = await setup();
    const projectId = '33333333-3333-3333-3333-333333333333';
    const published = await t.call('workspace.dispatch', {
      action: { type: 'publishSelectedProject', projectId },
    });
    expect(published.value).toMatchObject({ state: { selectedProjectId: projectId } });
    expect(t.workspace.state.selectedProjectId).toBe(projectId);
    const heard = t.events
      .filter((e) => e.name === 'workspace.changed')
      .map(
        (e) =>
          (e.payload as { state: { selectedProjectId: string | null } }).state.selectedProjectId,
      );
    expect(heard).toContain(projectId);
    const cleared = await t.call('workspace.dispatch', {
      action: { type: 'publishSelectedProject', projectId: null },
    });
    expect(cleared.value).toMatchObject({ state: { selectedProjectId: null } });
  });

  it('refuses the old folder action and a project id that is not a GUID at the wire', async () => {
    const t = await setup();
    expect(
      (
        await t.call('workspace.dispatch', {
          action: { type: 'publishSelectedFolder', folderId: null },
        })
      ).error?.code,
    ).toBe('invalid-input');
    expect(
      (
        await t.call('workspace.dispatch', {
          action: { type: 'publishSelectedProject', projectId: '../x' },
        })
      ).ok,
    ).toBe(false);
  });

  it('dispatches actions and returns the new state', async () => {
    const t = await setup();
    const result = await t.call('workspace.dispatch', {
      action: { type: 'openSession', tab: 'Summary' },
    });
    expect(result.value).toMatchObject({ state: { sessionTab: 'Summary' } });
    expect(t.events).toContainEqual({
      name: 'workspace.navigationRequested',
      payload: { tag: 'Session' },
    });
    expect((await t.call('workspace.getState')).value).toMatchObject({ sessionTab: 'Summary' });
  });

  it('rejects a bad tag at the wire, before the workspace sees it', async () => {
    const t = await setup();
    const result = await t.call('workspace.dispatch', {
      action: { type: 'navigateTo', tag: 'Transcript' },
    });
    expect(result.error?.code).toBe('invalid-input');
  });

  it('take-notes request and consume', async () => {
    const t = await setup();
    await t.call('workspace.dispatch', {
      action: { type: 'requestTakeNotes' },
    });
    const first = await t.call('workspace.dispatch', { action: { type: 'consumeTakeNotes' } });
    expect(first.value).toMatchObject({ takeNotes: { pending: true } });
    const second = await t.call('workspace.dispatch', { action: { type: 'consumeTakeNotes' } });
    expect(second.value).toMatchObject({ takeNotes: { pending: false } });
  });

  it('applyWorkspaceAction covers every action type', () => {
    const w = new Workspace();
    const actions = [
      { type: 'selectMeeting', id: 'm' },
      { type: 'setLastProcessed', id: 'm' },
      { type: 'setSessionTab', tab: 'Summary' },
      { type: 'setCurrentShellTag', tag: 'History' },
      { type: 'publishSelectedProject', projectId: 'f' },
      { type: 'setLiveTranscript', text: 'hi' },
      { type: 'setCaptureActive', active: true },
      { type: 'clearSelection' },
      { type: 'notifyMeetingChanged', id: 'm' },
      { type: 'navigateTo', tag: 'Settings' },
    ] as const;
    for (const action of actions) applyWorkspaceAction(w, action);
    expect(w.state).toMatchObject({
      sessionTab: 'Summary',
      currentShellTag: 'History',
      selectedProjectId: 'f',
      liveTranscript: 'hi',
      isCaptureActive: true,
      selectedMeetingId: null,
    });
  });
});
