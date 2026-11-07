import { describe, expect, it } from 'vitest';
import {
  libraryCreateFolder,
  libraryLoad,
  librarySetLocation,
  requestChannels,
  settingsUpdate,
  workspaceDispatch,
  workspaceActionSchema,
  actionItemSchema,
  meetingRecordSchema,
} from './index';

describe('library contracts', () => {
  it('registers every library request by name', () => {
    for (const name of [
      'library.load',
      'library.getMeeting',
      'library.createFolder',
      'library.renameFolder',
      'library.updateFolderPersonality',
      'library.setFolderNote',
      'library.deleteFolder',
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

  it('takes failures as values, not exceptions', () => {
    const failure = { ok: false, reason: 'name-taken' };
    expect(libraryCreateFolder.output.safeParse(failure).success).toBe(true);
    expect(
      libraryLoad.output.safeParse({ ok: false, reason: 'corrupt', message: 'x' }).success,
    ).toBe(true);
    expect(libraryCreateFolder.output.safeParse({ ok: false, reason: 'made-up' }).success).toBe(
      false,
    );
  });

  it('rejects a settings patch with an unknown key', () => {
    expect(settingsUpdate.input.safeParse({ patch: { uiLanguage: 'en' } }).success).toBe(true);
    expect(settingsUpdate.input.safeParse({ patch: { nope: 1 } }).success).toBe(false);
    expect(settingsUpdate.input.safeParse({ patch: { typeSafeEnabled: 'yes' } }).success).toBe(
      false,
    );
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
