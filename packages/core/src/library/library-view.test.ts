import { describe, expect, it } from 'vitest';
import {
  ALL_VIEW,
  NO_PROJECT_VIEW,
  emptyFlags,
  projectView,
  selectMeetings,
  type LibrarySnapshot,
} from './library-view';
import type { MeetingListItem } from './meeting';

const project = (id: string): { id: string } => ({ id });
const item = (
  id: string,
  title: string,
  recordedAt: string,
  projectId: string | null = null,
): MeetingListItem => ({
  id,
  title,
  recordedAt,
  endedAt: null,
  projectId,
  snippet: '',
  hasSummary: false,
  hasTranscript: false,
  busy: false,
});

const snapshot: LibrarySnapshot = {
  projects: [project('a'), project('b')],
  meetings: [
    item('1', 'Standup', '2026-09-01T10:00:00.0000000+00:00'),
    item('2', 'Planning', '2026-09-03T10:00:00.0000000+00:00', 'a'),
    item('3', 'Dangling', '2026-09-02T10:00:00.0000000+00:00', 'gone'),
    item('4', 'standup two', '2026-09-04T10:00:00.0000000+00:00', 'a'),
    item('5', 'Earlier by instant', '2026-09-04T09:00:00.0000000+05:00', 'a'),
  ],
};

describe('selectMeetings', () => {
  it('No project holds unfiled meetings and those whose project is unknown, newest first', () => {
    const { meetings, inViewCount } = selectMeetings(snapshot, NO_PROJECT_VIEW, '');
    expect(meetings.map((m) => m.id)).toEqual(['3', '1']);
    expect(inViewCount).toBe(2);
  });

  it('a project holds exactly its own meetings, sorted by instant, not by text', () => {
    expect(selectMeetings(snapshot, projectView('a'), '').meetings.map((m) => m.id)).toEqual([
      '4',
      '5',
      '2',
    ]);
  });

  it('searches titles only: trimmed, case-insensitive substring; count ignores the query', () => {
    const result = selectMeetings(snapshot, projectView('a'), '  STANDUP ');
    expect(result.meetings.map((m) => m.id)).toEqual(['4']);
    expect(result.inViewCount).toBe(3);
  });

  it('does not search snippets', () => {
    const snap = {
      ...snapshot,
      meetings: [{ ...item('9', 'Title', '2026-09-01T10:00:00+00:00'), snippet: 'needle' }],
    };
    expect(selectMeetings(snap, NO_PROJECT_VIEW, 'needle').meetings).toEqual([]);
  });

  it('All holds every meeting, newest first, whatever its project', () => {
    const { meetings, inViewCount } = selectMeetings(snapshot, ALL_VIEW, '');
    expect(meetings.map((m) => m.id)).toEqual(['4', '5', '2', '3', '1']);
    expect(inViewCount).toBe(5);
  });

  it('matches titles without regard to accents', () => {
    const snap = {
      projects: [],
      meetings: [item('1', 'Revisión del año', '2026-09-01T10:00:00+00:00')],
    };
    expect(selectMeetings(snap, ALL_VIEW, 'REVISION').meetings).toHaveLength(1);
    expect(selectMeetings(snap, ALL_VIEW, 'año').meetings).toHaveLength(1);
    expect(selectMeetings(snap, ALL_VIEW, 'ano').meetings).toHaveLength(1);
  });

  it('needs every word of the query in the title, in any order', () => {
    expect(selectMeetings(snapshot, ALL_VIEW, 'two standup').meetings.map((m) => m.id)).toEqual([
      '4',
    ]);
    expect(selectMeetings(snapshot, ALL_VIEW, 'standup three').meetings).toEqual([]);
  });
});

describe('emptyFlags truth table', () => {
  const base = {
    isLoading: false,
    isNoProjectSelected: true,
    inViewCount: 0,
    projectCount: 0,
    totalMeetings: 0,
    displayedCount: 0,
    query: '',
  };

  it('an empty library shows only the library message', () => {
    expect(emptyFlags(base)).toEqual({
      showLibraryEmpty: true,
      showNoProjectEmpty: false,
      showProjectEmpty: false,
      showNoMatches: false,
      hasMeetings: false,
      isEmpty: true,
    });
  });

  it('an empty No project view in a library that has projects shows its message', () => {
    expect(emptyFlags({ ...base, projectCount: 1 })).toMatchObject({
      showLibraryEmpty: false,
      showNoProjectEmpty: true,
    });
  });

  it('an empty No project view when meetings exist elsewhere shows its message', () => {
    expect(emptyFlags({ ...base, totalMeetings: 3 })).toMatchObject({
      showLibraryEmpty: false,
      showNoProjectEmpty: true,
    });
  });

  it('an empty project shows the project message', () => {
    expect(emptyFlags({ ...base, isNoProjectSelected: false, projectCount: 2 })).toMatchObject({
      showProjectEmpty: true,
      showNoProjectEmpty: false,
      showLibraryEmpty: false,
    });
  });

  it('shows nothing while loading', () => {
    expect(emptyFlags({ ...base, isLoading: true })).toMatchObject({
      showLibraryEmpty: false,
      showNoProjectEmpty: false,
      showProjectEmpty: false,
      isEmpty: false,
    });
  });

  it('a search with no matches reports it', () => {
    const flags = emptyFlags({ ...base, inViewCount: 4, totalMeetings: 4, query: 'zzz' });
    expect(flags.showNoMatches).toBe(true);
    expect(flags.showNoProjectEmpty).toBe(false);
    expect(
      emptyFlags({ ...base, inViewCount: 4, displayedCount: 1, query: 'a' }).showNoMatches,
    ).toBe(false);
    expect(emptyFlags({ ...base, inViewCount: 4, query: '   ' }).showNoMatches).toBe(false);
  });

  it('has meetings when something is displayed', () => {
    expect(emptyFlags({ ...base, displayedCount: 2, inViewCount: 2 })).toMatchObject({
      hasMeetings: true,
      isEmpty: false,
    });
  });
});
