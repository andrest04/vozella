// @vitest-environment jsdom
import type { MeetingListItemDto } from '@vozella/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confirmText,
  isConfirmDialog,
  useMeetingListDialogs,
  type DialogState,
} from './use-meeting-list-dialogs';

afterEach(cleanup);

const meeting = { id: 'm1', title: 'Standup', projectId: null } as MeetingListItemDto;

describe('confirmText', () => {
  it('words each confirmation from its own entry', () => {
    expect(confirmText({ kind: 'deleteMany', meetingIds: ['a', 'b'] })).toEqual({
      title: { key: 'Ui_LibraryDeleteManyTitle', args: ['2'] },
      description: { key: 'Ui_LibraryDeleteManyContent', args: [] },
      cancel: 'HistoryDelete_Cancel',
      primary: 'HistoryDelete_Primary',
    });
    expect(confirmText({ kind: 'deleteMeeting', meeting }).description).toEqual({
      key: 'Ui_LibraryDeleteContent',
      args: ['Standup'],
    });
  });

  it('tells a refused permanent delete from one asked for directly', () => {
    const direct = confirmText({ kind: 'deleteMeetingPermanently', meeting, refused: false });
    const refused = confirmText({ kind: 'deleteMeetingPermanently', meeting, refused: true });
    expect(direct.description.key).toBe('Ui_LibraryDeletePermanentDirect');
    expect(refused.description.key).toBe('Ui_LibraryDeletePermanentContent');
    expect(direct.primary).toBe('Ui_LibraryDeletePermanentPrimary');

    const many = (refusedMany: boolean) =>
      confirmText({ kind: 'deleteManyPermanently', meetingIds: ['a'], refused: refusedMany })
        .description;
    expect(many(false)).toEqual({ key: 'Ui_LibraryDeleteManyPermanent', args: ['1'] });
    expect(many(true)).toEqual({ key: 'Ui_LibraryDeleteManyRefused', args: ['1'] });
  });

  it('counts only the yes-or-no dialogs as confirmations', () => {
    const asks: DialogState[] = [{ kind: 'renameMeeting', meeting }];
    expect(asks.some(isConfirmDialog)).toBe(false);
    expect(isConfirmDialog({ kind: 'deleteMany', meetingIds: [] })).toBe(true);
  });
});

describe('useMeetingListDialogs', () => {
  it('keeps the closed dialog and the last confirmation for their fade-out', () => {
    const { result } = renderHook(() => useMeetingListDialogs());
    act(() => {
      result.current.openDialog({ kind: 'deleteMeeting', meeting });
    });
    expect(result.current.confirmOpen).toBe(true);
    act(() => {
      result.current.openDialog({ kind: 'renameMeeting', meeting });
    });
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.confirm).toEqual({ kind: 'deleteMeeting', meeting });
    act(() => {
      result.current.closeDialog();
    });
    expect(result.current.dialog).toBeNull();
    expect(result.current.shown).toEqual({ kind: 'renameMeeting', meeting });
  });
});
