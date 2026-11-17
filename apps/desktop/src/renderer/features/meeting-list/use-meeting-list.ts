import type {
  FailureReasonDto,
  MeetingDeleteModeDto,
  MeetingListItemDto,
} from '@vozella/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StringKey } from '../../i18n/translate';
import { filterMeetings } from './meeting-filters';
import {
  connectMeetingList,
  refreshMeetingList,
  useMeetingListStore,
  type LoadProblem,
  type SkippedFile,
} from './meeting-list-store';
import { useProjectDirectory } from './project-directory';
import { emptyKindOf, scopeKey, selectMeetings, type EmptyKind, type MeetingScope } from './scope';
import { mergeMatches, type SearchHits } from './search-results';
import { useMeetingSearch } from './use-meeting-search';

/** A message for the status line: a catalog key and the values for its placeholders. */
export interface StatusMessage {
  readonly key: StringKey;
  readonly args: readonly string[];
}

export interface MeetingListModel {
  readonly isLoading: boolean;
  readonly problem: LoadProblem | null;
  readonly skipped: readonly SkippedFile[];
  readonly scope: MeetingScope;
  /** The meetings shown: the scope, the search and the filters applied. */
  readonly meetings: readonly MeetingListItemDto[];
  /** Meetings in the scope before the search text and the filters. */
  readonly scopeCount: number;
  /** The filters alone emptied the list: without them the scope or the search has something. */
  readonly filtersHideAll: boolean;
  readonly empty: EmptyKind | null;
  readonly query: string;
  /** What the second stage found inside meetings, by meeting id. */
  readonly hits: SearchHits;
  readonly searching: boolean;
  readonly searchFailed: boolean;
  readonly status: StatusMessage | null;
  /** The ids of the projects that exist; null until they have loaded. */
  readonly knownProjectIds: ReadonlySet<string> | null;
  readonly setQuery: (value: string) => void;
  readonly dismissStatus: () => void;
  readonly showStatus: (message: StatusMessage) => void;
  readonly moveMeeting: (meetingId: string, projectId: string | null) => Promise<boolean>;
  /** Refuses a busy meeting before the dialog opens. True when the dialog may open. */
  readonly beginDelete: (meetingId: string) => Promise<boolean>;
  /** `trash-failed` means nothing was deleted and a permanent delete can be offered. */
  readonly deleteMeeting: (
    meetingId: string,
    mode?: MeetingDeleteModeDto,
  ) => Promise<'deleted' | 'trash-failed' | 'failed'>;
  /** Moves several in one request. Returns the ids that did not move. */
  readonly moveMeetings: (
    meetingIds: readonly string[],
    projectId: string | null,
  ) => Promise<readonly string[]>;
  /** Deletes several in one request. Failed ids stay; refused ids can go permanently instead. */
  readonly deleteMeetings: (
    meetingIds: readonly string[],
    mode: MeetingDeleteModeDto,
  ) => Promise<{ readonly failed: readonly string[]; readonly refused: readonly string[] }>;
  readonly openMeeting: (meetingId: string, tab: 'Transcript' | 'Summary') => void;
  readonly goRecord: () => void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isStorageReason = (reason: FailureReasonDto): boolean => reason.startsWith('storage-');

/**
 * What a meeting list works with: the store's last load seen through its scope, the search text and
 * the filters, plus every mutation. Rules live in `@vozella/core`; storage in the main process.
 */
export function useMeetingList(scope: MeetingScope): MeetingListModel {
  const isLoading = useMeetingListStore((state) => state.isLoading);
  const problem = useMeetingListStore((state) => state.problem);
  const skipped = useMeetingListStore((state) => state.skipped);
  const allMeetings = useMeetingListStore((state) => state.meetings);
  const filters = useMeetingListStore((state) => state.filters);
  const directory = useProjectDirectory();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusMessage | null>(null);

  // A list keeps the store connected while it shows, so it works wherever it is mounted; the shell
  // connects it too, and the connections are counted.
  useEffect(() => connectMeetingList(), []);

  // The store outlives the route, but opening a list has always read the library again, so
  // files that appeared without a change event still show up.
  useEffect(() => {
    if (!useMeetingListStore.getState().isLoading) void refreshMeetingList();
  }, []);

  // Another scope is another list: the search text starts over with it.
  const key = scopeKey(scope);
  useEffect(() => {
    setQuery('');
  }, [key]);

  const knownProjectIds = useMemo<ReadonlySet<string> | null>(() => {
    // Projects that cannot be read leave every meeting under No project.
    if (directory.storage.status !== 'ready') return new Set();
    return directory.status === 'loading' ? null : new Set(directory.projects.map((p) => p.id));
  }, [directory.status, directory.storage.status, directory.projects]);

  const search = useMeetingSearch(query, scope);
  const inScope = useMemo(
    () => selectMeetings(allMeetings, scope, knownProjectIds, ''),
    [allMeetings, scope, knownProjectIds],
  );
  const selection = useMemo(() => {
    const byTitle = selectMeetings(allMeetings, scope, knownProjectIds, query);
    const matches = mergeMatches(inScope.meetings, byTitle.meetings, search.hits);
    return {
      scopeCount: byTitle.inScopeCount,
      unfilteredCount: matches.length,
      meetings: filterMeetings(matches, filters, Date.now()),
    };
  }, [allMeetings, scope, knownProjectIds, query, inScope, search.hits, filters]);

  const filtersHideAll =
    !isLoading &&
    !search.searching &&
    selection.meetings.length === 0 &&
    selection.unfilteredCount > 0;
  const empty = emptyKindOf({
    isLoading,
    scope,
    inScopeCount: selection.scopeCount,
    totalMeetings: allMeetings.length,
    displayedCount: selection.meetings.length,
    query,
    filtersHideAll,
    searching: search.searching,
  });

  const failure = useCallback((reason: FailureReasonDto, message: string | undefined): void => {
    setStatus(
      reason === 'busy'
        ? { key: 'HistoryDelete_Busy', args: [] }
        : isStorageReason(reason)
          ? { key: 'Ui_ProjectsUnavailableNow', args: [] }
          : { key: 'Ui_LibraryMoveFailed', args: [message ?? reason] },
    );
  }, []);

  return {
    isLoading,
    problem,
    skipped,
    scope,
    meetings: selection.meetings,
    scopeCount: selection.scopeCount,
    filtersHideAll,
    empty,
    query,
    hits: search.hits,
    searching: search.searching,
    searchFailed: search.failed,
    status,
    knownProjectIds,
    setQuery,
    dismissStatus: () => {
      setStatus(null);
    },
    showStatus: setStatus,
    moveMeeting: async (meetingId, projectId) => {
      const result = await window.vozella.invoke('library.moveMeeting', { meetingId, projectId });
      await refreshMeetingList();
      if (result.ok) return true;
      failure(result.reason, result.message);
      return false;
    },
    beginDelete: async (meetingId) => {
      const { busy } = await window.vozella.invoke('library.isMeetingBusy', { meetingId });
      if (busy) setStatus({ key: 'HistoryDelete_Busy', args: [] });
      return !busy;
    },
    deleteMeeting: async (meetingId, mode = 'trash') => {
      const result = await window.vozella.invoke('library.deleteMeeting', { meetingId, mode });
      if (!result.ok && result.reason !== 'trash-failed') {
        setStatus(
          result.reason === 'busy'
            ? { key: 'HistoryDelete_Busy', args: [] }
            : { key: 'HistoryDelete_Failed', args: [result.message ?? result.reason] },
        );
      }
      await refreshMeetingList();
      if (result.ok) return 'deleted';
      return result.reason === 'trash-failed' ? 'trash-failed' : 'failed';
    },
    moveMeetings: async (meetingIds, projectId) => {
      try {
        const { results } = await window.vozella.invoke('library.moveMeetings', {
          meetingIds,
          projectId,
        });
        const failed = results.filter((r) => !r.ok).map((r) => r.meetingId);
        const storage = results.some((r) => !r.ok && isStorageReason(r.reason));
        if (storage) setStatus({ key: 'Ui_ProjectsUnavailableNow', args: [] });
        else if (failed.length > 0) {
          setStatus({
            key: 'Ui_LibraryBulkMoveFailed',
            args: [String(failed.length), String(meetingIds.length)],
          });
        }
        await refreshMeetingList();
        return failed;
      } catch (error) {
        setStatus({ key: 'Ui_LibraryMoveFailed', args: [messageOf(error)] });
        return meetingIds;
      }
    },
    deleteMeetings: async (meetingIds, mode) => {
      try {
        const { results } = await window.vozella.invoke('library.deleteMeetings', {
          meetingIds,
          mode,
        });
        const refused = results
          .filter((r) => !r.ok && r.reason === 'trash-failed')
          .map((r) => r.meetingId);
        const failed = results
          .filter((r) => !r.ok && r.reason !== 'trash-failed')
          .map((r) => r.meetingId);
        if (failed.length > 0) {
          setStatus({
            key: 'Ui_LibraryBulkDeleteFailed',
            args: [String(failed.length), String(meetingIds.length)],
          });
        }
        await refreshMeetingList();
        return { failed, refused };
      } catch (error) {
        setStatus({ key: 'HistoryDelete_Failed', args: [messageOf(error)] });
        return { failed: meetingIds, refused: [] };
      }
    },
    openMeeting: (meetingId, tab) => {
      void (async () => {
        await window.vozella.invoke('workspace.dispatch', {
          action: { type: 'selectMeeting', id: meetingId },
        });
        await window.vozella.invoke('workspace.dispatch', {
          action: { type: 'openSession', tab },
        });
      })();
    },
    goRecord: () => {
      void window.vozella.invoke('workspace.dispatch', {
        action: { type: 'navigateTo', tag: 'Recording' },
      });
    },
  };
}
