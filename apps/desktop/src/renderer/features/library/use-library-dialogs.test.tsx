// @vitest-environment jsdom
import type { MeetingListItemDto } from '@vozella/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestFolderAction, useLibraryStore } from './library-store';
import {
  confirmText,
  isConfirmDialog,
  useLibraryDialogs,
  type DialogState,
} from './use-library-dialogs';

afterEach(() => {
  cleanup();
  useLibraryStore.setState({ folderRequest: null });
});

const meeting = { id: 'm1', title: 'Standup', folderId: null } as MeetingListItemDto;

describe('confirmText', () => {
  it('words each confirmation from its own entry', () => {
    expect(confirmText({ kind: 'deleteFolder', folderId: 'f1', name: 'Work' })).toEqual({
      title: { key: 'LibraryDeleteFolder_Title', args: [] },
      description: { key: 'LibraryDeleteFolder_Content', args: ['Work'] },
      cancel: 'LibraryDeleteFolder_Cancel',
      primary: 'LibraryDeleteFolder_Primary',
    });
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
    const asks: DialogState[] = [
      { kind: 'newFolder' },
      { kind: 'move', meeting },
      { kind: 'renameMeeting', meeting },
    ];
    expect(asks.some(isConfirmDialog)).toBe(false);
    expect(isConfirmDialog({ kind: 'deleteMany', meetingIds: [] })).toBe(true);
  });
});

const mountDialogs = (deletable = true) => {
  const showStatus = vi.fn();
  const view = renderHook(() =>
    useLibraryDialogs({
      folderName: (id) => (id === 'f1' ? 'Work' : ''),
      canDeleteFolder: () => deletable,
      showStatus,
    }),
  );
  return { ...view, showStatus };
};

describe('useLibraryDialogs', () => {
  it('opens the dialog a sidebar folder request asks for, and clears the request', () => {
    const { result } = mountDialogs();
    act(() => {
      requestFolderAction({ kind: 'rename', folderId: 'f1' });
    });
    expect(result.current.dialog).toEqual({ kind: 'rename', folderId: 'f1', name: 'Work' });
    expect(useLibraryStore.getState().folderRequest).toBeNull();
  });

  it('reports a folder that cannot be deleted instead of asking', () => {
    const { result, showStatus } = mountDialogs(false);
    act(() => {
      result.current.runFolderAction({ kind: 'delete', folderId: 'f1' });
    });
    expect(result.current.dialog).toBeNull();
    expect(showStatus).toHaveBeenCalledWith({ key: 'LibraryDeleteFolder_NotEmpty', args: [] });
  });

  it('keeps the closed dialog and the last confirmation for their fade-out', () => {
    const { result } = mountDialogs();
    act(() => {
      result.current.openDialog({ kind: 'deleteMeeting', meeting });
    });
    expect(result.current.confirmOpen).toBe(true);
    act(() => {
      result.current.openDialog({ kind: 'move', meeting });
    });
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.confirm).toEqual({ kind: 'deleteMeeting', meeting });
    act(() => {
      result.current.closeDialog();
    });
    expect(result.current.dialog).toBeNull();
    expect(result.current.shown).toEqual({ kind: 'move', meeting });
  });
});
