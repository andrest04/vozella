import type { MeetingListItem } from './meeting';
import { parseOffsetDate } from './offset-date';
import { foldText, foldedWords, hasAllWords } from './text-fold';

/** Everything the Library page shows, as of the last load. */
export interface LibrarySnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly meetings: readonly MeetingListItem[];
}

/** When the meeting was recorded, for sorting. Offsets count, so text order is not enough. */
export function meetingInstant(item: Pick<MeetingListItem, 'recordedAt'>): number {
  return parseOffsetDate(item.recordedAt)?.ms ?? 0;
}

/** What the Library is showing: every meeting, the ones with no project, or one project's own. */
export type LibraryView =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly id: string };

export const ALL_VIEW: LibraryView = { kind: 'all' };
export const NO_PROJECT_VIEW: LibraryView = { kind: 'none' };
export const projectView = (id: string): LibraryView => ({ kind: 'project', id });

/** "No project" also holds meetings whose project id is not in the project set. */
export function isInLibraryView(
  view: LibraryView,
  knownProjectIds: ReadonlySet<string>,
  meeting: Pick<MeetingListItem, 'projectId'>,
): boolean {
  switch (view.kind) {
    case 'all':
      return true;
    case 'none':
      return meeting.projectId === null || !knownProjectIds.has(meeting.projectId);
    case 'project':
      return meeting.projectId === view.id;
  }
}

export interface MeetingSelection {
  readonly meetings: readonly MeetingListItem[];
  /** Meetings in the selected view before the search filter. */
  readonly inViewCount: number;
}

/**
 * Spec 3.13 `ApplyMeetingFilter`. Newest first; the query matches titles only, every word of it
 * in any order and without regard to case or accents.
 */
export function selectMeetings(
  snapshot: LibrarySnapshot,
  view: LibraryView,
  query: string,
): MeetingSelection {
  const known = new Set(snapshot.projects.map((p) => p.id));
  const inView = snapshot.meetings.filter((m) => isInLibraryView(view, known, m));
  const words = foldedWords(query);
  const matching =
    words.length === 0 ? inView : inView.filter((m) => hasAllWords(foldText(m.title), words));
  return {
    meetings: [...matching].sort((a, b) => meetingInstant(b) - meetingInstant(a)),
    inViewCount: inView.length,
  };
}

export interface EmptyFlagsInput {
  readonly isLoading: boolean;
  readonly isNoProjectSelected: boolean;
  readonly inViewCount: number;
  readonly projectCount: number;
  readonly totalMeetings: number;
  readonly displayedCount: number;
  readonly query: string;
}

export interface EmptyFlags {
  readonly showLibraryEmpty: boolean;
  readonly showNoProjectEmpty: boolean;
  readonly showProjectEmpty: boolean;
  /** B15: a search matched nothing in a view that has meetings. */
  readonly showNoMatches: boolean;
  readonly hasMeetings: boolean;
  readonly isEmpty: boolean;
}

/** Spec 2.9, plus the no-matches message the first version of the page lacked. */
export function emptyFlags(input: EmptyFlagsInput): EmptyFlags {
  const noProjectEmpty = input.isNoProjectSelected && input.inViewCount === 0;
  const showLibraryEmpty =
    !input.isLoading && noProjectEmpty && input.projectCount === 0 && input.totalMeetings === 0;
  const hasMeetings = input.displayedCount > 0;
  return {
    showLibraryEmpty,
    showNoProjectEmpty: !input.isLoading && noProjectEmpty && !showLibraryEmpty,
    showProjectEmpty: !input.isLoading && !input.isNoProjectSelected && input.inViewCount === 0,
    showNoMatches:
      !input.isLoading &&
      input.query.trim() !== '' &&
      input.inViewCount > 0 &&
      input.displayedCount === 0,
    hasMeetings,
    isEmpty: !input.isLoading && !hasMeetings,
  };
}
