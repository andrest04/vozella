// @vitest-environment jsdom
import type { MeetingListItemDto } from '@vozella/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Translate } from '../../i18n/translate';
import { useBulkActions } from './use-bulk-actions';
import type { LibraryModel } from './use-library';

afterEach(() => {
  cleanup();
});

const item = (id: string, folderId: string | null = null) =>
  ({ id, title: `Title ${id}`, folderId }) as MeetingListItemDto;

/** Shows the key and its values, so a test reads what the user would. */
const t: Translate = (key, ...args) => [key, ...args].join('|');

type Library = Parameters<typeof useBulkActions>[0]['library'];

const fakeLibrary = (meetings: readonly MeetingListItemDto[], extra: Partial<Library> = {}) =>
  ({
    meetings,
    folders: [{ id: 'f1', name: 'Work' }] as unknown as LibraryModel['folders'],
    destinations: [
      { folderId: null, path: 'Inbox' },
      { folderId: 'f1', path: 'Work' },
    ] as unknown as LibraryModel['destinations'],
    searching: false,
    beginDelete: vi.fn(() => Promise.resolve(true)),
    moveMeetings: vi.fn(() => Promise.resolve([] as readonly string[])),
    deleteMeetings: vi.fn(() => Promise.resolve({ failed: [], refused: [] })),
    ...extra,
  }) satisfies Library;

const mount = (library: Library, listKey = 'all') => {
  const openDialog = vi.fn();
  const afterWork = vi.fn();
  const view = renderHook(
    (props: { library: Library; listKey: string }) =>
      useBulkActions({
        library: props.library,
        listedIds: props.library.meetings.map((m) => m.id),
        t,
        listKey: props.listKey,
        openDialog,
        afterWork,
      }),
    { initialProps: { library, listKey } },
  );
  return { ...view, openDialog, afterWork };
};

describe('useBulkActions', () => {
  it('applies a row action to every checked meeting, or to the row alone', () => {
    const [a, b, c] = [item('a'), item('b'), item('c')];
    const { result } = mount(fakeLibrary([a, b, c]));
    act(() => {
      result.current.toggleCheck('a');
      result.current.toggleCheck('b');
    });
    expect(result.current.targetsOf(a).map((m) => m.id)).toEqual(['a', 'b']);
    expect(result.current.targetsOf(c).map((m) => m.id)).toEqual(['c']);
  });

  it('starts another list with no checks', () => {
    const library = fakeLibrary([item('a')]);
    const { result, rerender } = mount(library);
    act(() => {
      result.current.toggleCheck('a');
    });
    expect(result.current.checks.checked.size).toBe(1);
    rerender({ library, listKey: 'inbox' });
    expect(result.current.checks.checked.size).toBe(0);
  });

  it('waits for the search to finish before Select all checks the list', () => {
    const searching = fakeLibrary([item('a')], { searching: true });
    const { result, rerender } = mount(searching);
    act(() => {
      result.current.selectAll();
    });
    expect(result.current.checks.checked.size).toBe(0);
    rerender({ library: fakeLibrary([item('a'), item('b')]), listKey: 'all' });
    expect([...result.current.checks.checked]).toEqual(['a', 'b']);
  });

  it('asks once for several meetings, and checks a single delete with the library first', async () => {
    const library = fakeLibrary([item('a'), item('b')]);
    const { result, openDialog } = mount(library);
    act(() => {
      result.current.askDelete([item('a'), item('b')], true);
    });
    expect(openDialog).toHaveBeenCalledWith({
      kind: 'deleteManyPermanently',
      meetingIds: ['a', 'b'],
      refused: false,
    });
    await act(async () => {
      result.current.askDelete([item('a')], false);
      await Promise.resolve();
    });
    expect(library.beginDelete).toHaveBeenCalledWith('a');
    expect(openDialog).toHaveBeenLastCalledWith({ kind: 'deleteMeeting', meeting: item('a') });
  });

  it('moves the ones not there yet and offers to put each back where it was', async () => {
    const meetings = [item('a'), item('b', 'f1'), item('c', 'gone')];
    const library = fakeLibrary(meetings);
    const { result, afterWork } = mount(library);
    await act(async () => {
      await result.current.runMoveMany(meetings, 'f1');
    });
    expect(library.moveMeetings).toHaveBeenCalledWith(['a', 'c'], 'f1');
    // A folder that is gone reads as the Inbox.
    expect(result.current.undoMove).toEqual({
      message: 'Ui_LibraryMovedMany|2|Work',
      restore: [{ folderId: null, meetingIds: ['a', 'c'] }],
    });
    expect(result.current.bulkWork).toBeNull();
    expect(afterWork).toHaveBeenCalledOnce();

    const undo = result.current.undoMove;
    if (!undo) throw new Error('The move offered no undo.');
    await act(async () => {
      await result.current.runUndo(undo);
    });
    expect(library.moveMeetings).toHaveBeenLastCalledWith(['a', 'c'], null);
    expect(result.current.undoMove).toBeNull();
  });

  it('offers the permanent delete for the meetings the Recycle Bin refused', async () => {
    const library = fakeLibrary([item('a'), item('b')], {
      deleteMeetings: vi.fn(() => Promise.resolve({ failed: [], refused: ['b'] })),
    });
    const { result, openDialog, afterWork } = mount(library);
    act(() => {
      result.current.toggleCheck('b');
    });
    await act(async () => {
      await result.current.runDeleteMany(['a', 'b'], 'trash');
    });
    expect(openDialog).toHaveBeenCalledWith({
      kind: 'deleteManyPermanently',
      meetingIds: ['b'],
      refused: true,
    });
    expect([...result.current.checks.checked]).toEqual(['b']);
    expect(afterWork).toHaveBeenCalledOnce();
  });
});
