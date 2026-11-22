import { useMemo } from 'react';
import { useMeetingListStore } from '../meeting-list/meeting-list-store';

/**
 * Meeting titles by id for chat thread rows, or null while the meetings load (so no thread is
 * called deleted before the list is known).
 */
export function useMeetingTitles(): ReadonlyMap<string, string> | null {
  const meetings = useMeetingListStore((state) => state.meetings);
  const loaded = useMeetingListStore((state) => !state.isLoading);
  return useMemo(
    () => (loaded ? new Map(meetings.map((meeting) => [meeting.id, meeting.title])) : null),
    [loaded, meetings],
  );
}
