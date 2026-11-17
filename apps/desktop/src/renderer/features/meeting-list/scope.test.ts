import type { MeetingListItemDto } from '@vozella/contracts';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE,
  NONE_SCOPE,
  emptyKindOf,
  inScope,
  projectScope,
  scopeKey,
  selectMeetings,
} from './scope';

const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';

const meeting = (id: string, title: string, recordedAt: string, projectId: string | null) =>
  ({ id, title, recordedAt, projectId }) as MeetingListItemDto;

const meetings = [
  meeting('a', 'Standup', '2026-09-01T09:00:00.0000000+00:00', null),
  meeting('b', 'Planning', '2026-09-03T09:00:00.0000000+00:00', P1),
  meeting('c', 'Revisión de cálculo', '2026-09-02T09:00:00.0000000+00:00', 'gone'),
  meeting('d', 'Retro', '2026-09-04T09:00:00.0000000+00:00', P2),
];
const known = new Set([P1, P2]);

describe('scope', () => {
  it('names a scope for keys and for the search channel', () => {
    expect(scopeKey(ALL_SCOPE)).toBe('all');
    expect(scopeKey(NONE_SCOPE)).toBe('none');
    expect(scopeKey(projectScope(P1))).toBe(`project:${P1}`);
  });

  it('puts a meeting with an unknown project id under No project', () => {
    expect(inScope(NONE_SCOPE, known, meetings[2]!)).toBe(true);
    expect(inScope(NONE_SCOPE, known, meetings[1]!)).toBe(false);
    expect(inScope(projectScope(P1), known, meetings[1]!)).toBe(true);
    expect(inScope(projectScope(P1), known, meetings[2]!)).toBe(false);
    expect(inScope(ALL_SCOPE, known, meetings[2]!)).toBe(true);
  });

  it('treats every id as known until the projects have loaded', () => {
    expect(inScope(NONE_SCOPE, null, meetings[2]!)).toBe(false);
  });

  it('lists the scope newest first and matches titles by folded words', () => {
    expect(selectMeetings(meetings, ALL_SCOPE, known, '').meetings.map((m) => m.id)).toEqual([
      'd',
      'b',
      'c',
      'a',
    ]);
    const found = selectMeetings(meetings, NONE_SCOPE, known, 'REVISION calculo');
    expect(found.meetings.map((m) => m.id)).toEqual(['c']);
    expect(found.inScopeCount).toBe(2);
  });
});

describe('emptyKindOf', () => {
  const base = {
    isLoading: false,
    scope: ALL_SCOPE,
    inScopeCount: 0,
    totalMeetings: 0,
    displayedCount: 0,
    query: '',
    filtersHideAll: false,
    searching: false,
  };
  it('says nothing while loading or while rows are shown', () => {
    expect(emptyKindOf({ ...base, isLoading: true })).toBeNull();
    expect(
      emptyKindOf({ ...base, displayedCount: 2, inScopeCount: 2, totalMeetings: 2 }),
    ).toBeNull();
  });
  it('names the empty scope', () => {
    expect(emptyKindOf(base)).toBe('library');
    expect(emptyKindOf({ ...base, scope: NONE_SCOPE, totalMeetings: 5 })).toBe('none');
    expect(emptyKindOf({ ...base, scope: projectScope(P1), totalMeetings: 5 })).toBe('project');
  });
  it('tells filters and a search that found nothing from an empty scope', () => {
    const busy = { ...base, inScopeCount: 4, totalMeetings: 4 };
    expect(emptyKindOf({ ...busy, filtersHideAll: true })).toBe('filters');
    expect(emptyKindOf({ ...busy, query: 'zzz' })).toBe('no-matches');
    expect(emptyKindOf({ ...busy, query: 'zzz', searching: true })).toBeNull();
  });
});
