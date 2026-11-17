import { describe, expect, it } from 'vitest';
import {
  libraryChanged,
  libraryLoad,
  libraryMoveMeeting,
  libraryMoveMeetings,
  librarySearch,
  librarySetLocation,
  meetingListItemSchema,
  recordingStart,
  recordingImport,
  recordingImportUrl,
  shellTagSchema,
  workspaceStateSchema,
  requestChannels,
  settingsUpdate,
  workspaceDispatch,
  workspaceActionSchema,
  actionItemSchema,
  meetingRecordSchema,
} from './index';

const PROJECT = '9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b';

describe('library contracts', () => {
  it('registers every library request by name', () => {
    for (const name of [
      'library.load',
      'library.getMeeting',
      'library.moveMeeting',
      'library.deleteMeeting',
      'library.moveMeetings',
      'library.deleteMeetings',
      'library.search',
      'library.isMeetingBusy',
      'library.getLocation',
      'library.openFolder',
      'library.chooseLocation',
      'library.setLocation',
      'settings.get',
      'settings.update',
      'workspace.getState',
      'workspace.dispatch',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
  });

  it('no longer registers the folder channels', () => {
    for (const name of [
      'library.createFolder',
      'library.renameFolder',
      'library.updateFolderPersonality',
      'library.setFolderNote',
      'library.deleteFolder',
    ]) {
      expect(Object.keys(requestChannels)).not.toContain(name);
    }
  });

  it('takes failures as values, not exceptions', () => {
    expect(
      libraryLoad.output.safeParse({ ok: false, reason: 'corrupt', message: 'x' }).success,
    ).toBe(true);
    expect(libraryLoad.output.safeParse({ ok: false, reason: 'made-up' }).success).toBe(false);
  });

  it('library.load carries no folders and reports shadowed meeting copies', () => {
    const loaded = {
      ok: true,
      meetings: [],
      skipped: [],
      shadowed: [{ id: 'm1', keptPath: 'C:\\L\\a.md', shadowedPath: 'C:\\L\\b.md' }],
    };
    expect(libraryLoad.output.parse(loaded)).toEqual(loaded);
    expect(libraryLoad.output.safeParse({ ok: true, meetings: [], skipped: [] }).success).toBe(
      false,
    );
    expect(libraryLoad.output.parse({ ...loaded, folders: [] })).not.toHaveProperty('folders');
  });

  it('a meeting names its project, and a move can fail because storage is not ready', () => {
    const item = {
      id: 'm1',
      title: 't',
      recordedAt: 'r',
      endedAt: null,
      projectId: PROJECT,
      snippet: '',
      hasSummary: false,
      hasTranscript: false,
      busy: false,
    };
    expect(meetingListItemSchema.parse(item)).toEqual(item);
    expect(meetingListItemSchema.safeParse({ ...item, projectId: undefined }).success).toBe(false);
    for (const reason of ['storage-migrating', 'storage-error', 'storage-newer']) {
      expect(libraryMoveMeeting.output.safeParse({ ok: false, reason }).success).toBe(true);
      expect(
        libraryMoveMeetings.output.safeParse({ results: [{ meetingId: 'm', ok: false, reason }] })
          .success,
      ).toBe(true);
    }
  });

  it('moves take a project id (lowercased) or null, never a folder id', () => {
    expect(
      libraryMoveMeeting.input.parse({ meetingId: 'm', projectId: PROJECT.toUpperCase() }),
    ).toEqual({
      meetingId: 'm',
      projectId: PROJECT,
    });
    expect(libraryMoveMeeting.input.safeParse({ meetingId: 'm', projectId: null }).success).toBe(
      true,
    );
    expect(libraryMoveMeeting.input.safeParse({ meetingId: 'm', projectId: '../x' }).success).toBe(
      false,
    );
    expect(libraryMoveMeeting.input.safeParse({ meetingId: 'm', folderId: null }).success).toBe(
      false,
    );
    expect(
      libraryMoveMeetings.input.safeParse({ meetingIds: ['m'], projectId: PROJECT }).success,
    ).toBe(true);
  });

  it('search scopes are all, none or one project', () => {
    const base = { query: 'q', requestId: 1 };
    expect(librarySearch.input.safeParse({ ...base, scope: { kind: 'all' } }).success).toBe(true);
    expect(librarySearch.input.safeParse({ ...base, scope: { kind: 'none' } }).success).toBe(true);
    expect(
      librarySearch.input.parse({ ...base, scope: { kind: 'project', id: PROJECT.toUpperCase() } })
        .scope,
    ).toEqual({ kind: 'project', id: PROJECT });
    expect(librarySearch.input.safeParse({ ...base, scope: { kind: 'inbox' } }).success).toBe(
      false,
    );
    expect(
      librarySearch.input.safeParse({ ...base, scope: { kind: 'folder', id: PROJECT } }).success,
    ).toBe(false);
    expect(
      librarySearch.input.safeParse({ ...base, scope: { kind: 'project', id: 'x' } }).success,
    ).toBe(false);
  });

  it('library.changed says meeting, project or location', () => {
    for (const reason of ['meeting', 'project', 'location']) {
      expect(libraryChanged.payload.safeParse({ reason }).success).toBe(true);
    }
    expect(libraryChanged.payload.safeParse({ reason: 'folder' }).success).toBe(false);
  });

  it('recording start and imports take a project id, never a folder id', () => {
    const start = { title: 't', projectId: PROJECT, microphone: null, appName: null };
    const parsedStart = recordingStart.input.safeParse(start);
    expect(parsedStart.success).toBe(true);
    expect(recordingStart.input.safeParse({ ...start, projectId: null }).success).toBe(true);
    expect(recordingStart.input.safeParse({ ...start, projectId: 'f1' }).success).toBe(false);
    expect(
      recordingImport.input.safeParse({ title: 't', projectId: PROJECT, path: 'C:\\a.mp3' })
        .success,
    ).toBe(true);
    expect(
      recordingImportUrl.input.safeParse({ title: 't', projectId: null, url: 'https://x.y/z' })
        .success,
    ).toBe(true);
    expect(
      recordingImportUrl.input.safeParse({ title: 't', folderId: null, url: 'https://x.y/z' })
        .success,
    ).toBe(false);
  });

  it('rejects a settings patch with an unknown key', () => {
    expect(settingsUpdate.input.safeParse({ patch: { uiLanguage: 'en' } }).success).toBe(true);
    expect(settingsUpdate.input.safeParse({ patch: { nope: 1 } }).success).toBe(false);
    expect(settingsUpdate.input.safeParse({ patch: { meetingPopupEnabled: 'yes' } }).success).toBe(
      false,
    );
  });

  it('a settings patch can choose the transcription engine and its cloud model', () => {
    const patch = { transcriptionEngine: 'Groq', cloudTranscriptionModelId: 'whisper-large-v3' };
    expect(settingsUpdate.input.safeParse({ patch }).success).toBe(true);
    // Back to the local engine and to the provider's default model.
    expect(
      settingsUpdate.input.safeParse({
        patch: { transcriptionEngine: null, cloudTranscriptionModelId: null },
      }).success,
    ).toBe(true);
    expect(settingsUpdate.input.safeParse({ patch: { transcriptionEngine: 1 } }).success).toBe(
      false,
    );
  });

  it('the Projects shell tag exists and a project can be published as selected', () => {
    expect(shellTagSchema.safeParse('Projects').success).toBe(true);
    expect(shellTagSchema.safeParse('Folders').success).toBe(false);
    expect(workspaceActionSchema.safeParse({ type: 'navigateTo', tag: 'Projects' }).success).toBe(
      true,
    );
    expect(
      workspaceActionSchema.parse({
        type: 'publishSelectedProject',
        projectId: PROJECT.toUpperCase(),
      }),
    ).toEqual({ type: 'publishSelectedProject', projectId: PROJECT });
    expect(
      workspaceActionSchema.safeParse({ type: 'publishSelectedProject', projectId: null }).success,
    ).toBe(true);
    expect(
      workspaceActionSchema.safeParse({ type: 'publishSelectedFolder', folderId: null }).success,
    ).toBe(false);
    expect(workspaceStateSchema.shape).toHaveProperty('selectedProjectId');
    expect(workspaceStateSchema.shape).not.toHaveProperty('selectedFolderId');
  });

  it('validates workspace actions', () => {
    expect(workspaceActionSchema.safeParse({ type: 'navigateTo', tag: 'History' }).success).toBe(
      true,
    );
    expect(workspaceActionSchema.safeParse({ type: 'navigateTo', tag: 'Transcript' }).success).toBe(
      false,
    );
    expect(
      workspaceActionSchema.safeParse({ type: 'setSessionTab', tab: 'Settings' }).success,
    ).toBe(false);
    expect(workspaceDispatch.input.safeParse({ action: { type: 'bogus' } }).success).toBe(false);
  });

  it('set location takes a path or null', () => {
    expect(librarySetLocation.input.safeParse({ path: null }).success).toBe(true);
    expect(librarySetLocation.input.safeParse({}).success).toBe(false);
  });
});

describe('action item contract (owner and deadline)', () => {
  it('accepts the legacy shape and the optional owner and deadline', () => {
    expect(actionItemSchema.safeParse({ text: 'a', isDone: false }).success).toBe(true);
    const full = {
      text: 'a',
      isDone: false,
      owner: 'Ana',
      deadline: {
        quote: 'el viernes',
        kind: { type: 'weekday', weekday: 'fri' },
        date: '2026-11-06',
      },
    };
    expect(actionItemSchema.parse(full)).toEqual(full);
    for (const kind of [
      { type: 'date', date: '2026-12-01' },
      { type: 'in_days', days: 3 },
      { type: 'next_week' },
      { type: 'next_meeting' },
      { type: 'unknown' },
    ]) {
      expect(actionItemSchema.safeParse({ ...full, deadline: { quote: 'q', kind } }).success).toBe(
        true,
      );
    }
  });

  it('rejects malformed deadlines', () => {
    const item = (deadline: unknown) => ({ text: 'a', isDone: false, deadline });
    for (const bad of [
      { quote: 'q', kind: { type: 'soon' } },
      { quote: 'q', kind: { type: 'weekday', weekday: 'fr' } },
      { quote: 'q', kind: { type: 'in_days', days: -1 } },
      { quote: 'q', kind: { type: 'next_week' }, date: '06/11/2026' },
      { kind: { type: 'next_week' } },
    ]) {
      expect(actionItemSchema.safeParse(item(bad)).success).toBe(false);
    }
  });

  it('carries owner and deadline on the meeting record', () => {
    const shape = meetingRecordSchema.shape.actionItems;
    const parsed = shape.parse([
      {
        text: 'a',
        isDone: true,
        owner: 'Ana',
        deadline: { quote: 'q', kind: { type: 'next_meeting' } },
      },
    ]);
    expect(parsed[0]?.owner).toBe('Ana');
  });
});
