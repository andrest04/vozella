import type { MeetingListItemDto } from '@vozella/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translate } from '../../i18n/translate';
import { clearDropRequest, useLibraryStore } from './library-store';
import {
  EMPTY_CHECKS,
  checkAll,
  extendChecks,
  keepLive,
  setGroup,
  toggleCheck,
  type Checks,
} from './library-selection';
import type { LibraryModel } from './use-library';
import type { DialogState } from './use-library-dialogs';

/** One move that can be taken back: where each meeting was, grouped by that place. */
export interface UndoMove {
  readonly message: string;
  readonly restore: readonly {
    readonly folderId: string | null;
    readonly meetingIds: readonly string[];
  }[];
}

export type BulkWork = { readonly kind: 'moving' | 'deleting'; readonly count: number } | null;

type BulkLibrary = Pick<
  LibraryModel,
  | 'meetings'
  | 'folders'
  | 'destinations'
  | 'searching'
  | 'beginDelete'
  | 'moveMeetings'
  | 'deleteMeetings'
>;

interface BulkOptions {
  readonly library: BulkLibrary;
  /** The ids of `library.meetings`, in list order. */
  readonly listedIds: readonly string[];
  readonly t: Translate;
  /** Changes when the list is another one: another view, search or filter. Checks start over. */
  readonly listKey: string;
  readonly openDialog: (dialog: DialogState) => void;
  readonly afterWork: () => void;
}

/**
 * The checked meetings and what runs on several at once: move, delete, the undo of a move and the
 * meetings dropped on a sidebar folder.
 */
export function useBulkActions({
  library,
  listedIds,
  t,
  listKey,
  openDialog,
  afterWork,
}: BulkOptions) {
  // Checks belong to one list: another view or another search starts with none.
  const [checks, setChecks] = useState<Checks>(EMPTY_CHECKS);
  const [bulkWork, setBulkWork] = useState<BulkWork>(null);
  useEffect(() => {
    setChecks(EMPTY_CHECKS);
  }, [listKey]);
  useEffect(() => {
    setChecks((current) => keepLive(current, listedIds));
  }, [listedIds]);
  const checkedMeetings = useMemo(
    () => library.meetings.filter((m) => checks.checked.has(m.id)),
    [library.meetings, checks.checked],
  );

  const onExtendChecks = useCallback(
    (fromId: string, toId: string): void => {
      setChecks((current) => extendChecks(current, listedIds, fromId, toId));
    },
    [listedIds],
  );

  // Ctrl+A on a list the second stage is still filling waits for the whole list.
  const selectAllPending = useRef(false);
  useEffect(() => {
    selectAllPending.current = false;
  }, [listKey]);
  useEffect(() => {
    if (!selectAllPending.current || library.searching) return;
    selectAllPending.current = false;
    setChecks(checkAll(listedIds));
  }, [library.searching, listedIds]);

  /** A row action from a checked row applies to all the checked ones, and alone otherwise. */
  const targetsOf = (meeting: MeetingListItemDto): readonly MeetingListItemDto[] =>
    checks.checked.has(meeting.id) ? checkedMeetings : [meeting];

  const askMove = (targets: readonly MeetingListItemDto[]): void => {
    const [only] = targets;
    if (!only) return;
    if (targets.length === 1) openDialog({ kind: 'move', meeting: only });
    else openDialog({ kind: 'moveMany', meetings: targets });
  };

  const askDelete = (targets: readonly MeetingListItemDto[], permanent: boolean): void => {
    const [only] = targets;
    if (!only) return;
    if (targets.length > 1) {
      const meetingIds = targets.map((m) => m.id);
      openDialog(
        permanent
          ? { kind: 'deleteManyPermanently', meetingIds, refused: false }
          : { kind: 'deleteMany', meetingIds },
      );
      return;
    }
    void library.beginDelete(only.id).then((allowed) => {
      if (!allowed) return;
      openDialog(
        permanent
          ? { kind: 'deleteMeetingPermanently', meeting: only, refused: false }
          : { kind: 'deleteMeeting', meeting: only },
      );
    });
  };

  const [undoMove, setUndoMove] = useState<UndoMove | null>(null);
  const dismissUndo = useCallback(() => {
    setUndoMove(null);
  }, []);

  /** Offers the way back from a move that happened. A folder that is gone reads as the Inbox. */
  const offerUndo = (moved: readonly MeetingListItemDto[], folderId: string | null): void => {
    const [first] = moved;
    if (!first) return;
    const groups = new Map<string | null, string[]>();
    for (const meeting of moved) {
      const known = library.folders.some((f) => f.id === meeting.folderId);
      const from = known ? meeting.folderId : null;
      groups.set(from, [...(groups.get(from) ?? []), meeting.id]);
    }
    const place = library.destinations.find((d) => d.folderId === folderId)?.path ?? '';
    setUndoMove({
      message:
        moved.length === 1
          ? t('Ui_LibraryMovedOne', first.title, place)
          : t('Ui_LibraryMovedMany', String(moved.length), place),
      restore: [...groups].map(([from, meetingIds]) => ({ folderId: from, meetingIds })),
    });
  };

  const runMoveMany = async (
    meetings: readonly MeetingListItemDto[],
    folderId: string | null,
  ): Promise<void> => {
    const moving = meetings.filter((m) => m.folderId !== folderId);
    if (moving.length === 0) return;
    setUndoMove(null);
    // One meeting is too quick to report, and "Moving 1 meetings" is not a sentence.
    if (moving.length > 1) setBulkWork({ kind: 'moving', count: moving.length });
    const failed = await library.moveMeetings(
      moving.map((m) => m.id),
      folderId,
    );
    setBulkWork(null);
    setChecks((current) => keepLive(current, failed));
    offerUndo(
      moving.filter((m) => !failed.includes(m.id)),
      folderId,
    );
    afterWork();
  };

  const runUndo = async (undo: UndoMove): Promise<void> => {
    setUndoMove(null);
    for (const { folderId, meetingIds } of undo.restore) {
      await library.moveMeetings(meetingIds, folderId);
    }
  };

  // A drop in the sidebar leaves its request here, like its folder actions.
  const dropRequest = useLibraryStore((state) => state.dropRequest);
  const runDrop = useRef(runMoveMany);
  runDrop.current = runMoveMany;
  useEffect(() => {
    if (!dropRequest) return;
    clearDropRequest();
    const { meetings } = useLibraryStore.getState();
    const wanted = new Set(dropRequest.meetingIds);
    void runDrop.current(
      meetings.filter((m) => wanted.has(m.id)),
      dropRequest.folderId,
    );
  }, [dropRequest]);

  const runDeleteMany = async (
    meetingIds: readonly string[],
    mode: 'trash' | 'permanent',
  ): Promise<void> => {
    setBulkWork({ kind: 'deleting', count: meetingIds.length });
    const { failed, refused } = await library.deleteMeetings(meetingIds, mode);
    setBulkWork(null);
    setChecks((current) => keepLive(current, [...failed, ...refused]));
    if (refused.length > 0) {
      openDialog({ kind: 'deleteManyPermanently', meetingIds: refused, refused: true });
    }
    afterWork();
  };

  return {
    checks,
    checkedMeetings,
    bulkWork,
    undoMove,
    targetsOf,
    askMove,
    askDelete,
    offerUndo,
    runMoveMany,
    runDeleteMany,
    runUndo,
    dismissUndo,
    onExtendChecks,
    toggleCheck: (id: string): void => {
      setChecks((current) => toggleCheck(current, id));
    },
    setDayChecks: (ids: readonly string[], on: boolean): void => {
      setChecks((current) => setGroup(current, ids, on));
    },
    clearChecks: (): void => {
      setChecks(EMPTY_CHECKS);
    },
    selectAll: (): void => {
      if (library.searching) selectAllPending.current = true;
      else setChecks(checkAll(listedIds));
    },
  };
}
