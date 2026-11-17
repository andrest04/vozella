import type { LibraryViewDto, MeetingListItemDto } from '@vozella/contracts';
import { foldText, foldedWords, hasAllWords, parseOffsetDate } from '@vozella/core';

/**
 * Which meetings a list shows: all of them, those in no project, or one project's. It is the
 * same shape the search channel takes, so a scope goes to `library.search` as it is.
 */
export type MeetingScope = LibraryViewDto;

export const ALL_SCOPE: MeetingScope = { kind: 'all' };
export const NONE_SCOPE: MeetingScope = { kind: 'none' };
export const projectScope = (id: string): MeetingScope => ({ kind: 'project', id });

export const scopeKey = (scope: MeetingScope): string =>
  scope.kind === 'project' ? `project:${scope.id}` : scope.kind;

/**
 * A meeting whose project id is not a project (deleted, or never existed) reads as no project.
 * Until the projects have loaded (`known` is null) every id is taken as real, so nothing moves
 * between lists while the answer is on its way.
 */
export function inScope(
  scope: MeetingScope,
  known: ReadonlySet<string> | null,
  meeting: Pick<MeetingListItemDto, 'projectId'>,
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'none':
      return meeting.projectId === null || (known !== null && !known.has(meeting.projectId));
    case 'project':
      return meeting.projectId === scope.id;
  }
}

/** When the meeting was recorded, for sorting. Offsets count, so text order is not enough. */
const instantOf = (meeting: Pick<MeetingListItemDto, 'recordedAt'>): number =>
  parseOffsetDate(meeting.recordedAt)?.ms ?? 0;

export interface MeetingSelection {
  readonly meetings: readonly MeetingListItemDto[];
  /** Meetings in the scope before the search text applies. */
  readonly inScopeCount: number;
}

/** The scope, newest first; the query matches titles, every word of it in any order. */
export function selectMeetings(
  meetings: readonly MeetingListItemDto[],
  scope: MeetingScope,
  known: ReadonlySet<string> | null,
  query: string,
): MeetingSelection {
  const inside = meetings.filter((meeting) => inScope(scope, known, meeting));
  const words = foldedWords(query);
  const matching =
    words.length === 0 ? inside : inside.filter((m) => hasAllWords(foldText(m.title), words));
  return {
    meetings: [...matching].sort((a, b) => instantOf(b) - instantOf(a)),
    inScopeCount: inside.length,
  };
}

export type EmptyKind = 'library' | 'none' | 'project' | 'filters' | 'no-matches';

export interface EmptyKindInput {
  readonly isLoading: boolean;
  readonly scope: MeetingScope;
  readonly inScopeCount: number;
  readonly totalMeetings: number;
  readonly displayedCount: number;
  readonly query: string;
  /** The filters alone emptied a list that has meetings. */
  readonly filtersHideAll: boolean;
  /** The second stage of the search is still reading inside meetings. */
  readonly searching: boolean;
}

/** Which message an empty list owes the reader; null when rows show or it is not known yet. */
export function emptyKindOf(input: EmptyKindInput): EmptyKind | null {
  if (input.isLoading || input.displayedCount > 0) return null;
  if (input.filtersHideAll) return 'filters';
  if (input.inScopeCount > 0) {
    // Nothing matched is not known yet while the second stage is still reading.
    return input.query.trim() !== '' && !input.searching ? 'no-matches' : null;
  }
  if (input.scope.kind === 'none') return 'none';
  if (input.scope.kind === 'project') return 'project';
  return input.totalMeetings === 0 ? 'library' : null;
}
