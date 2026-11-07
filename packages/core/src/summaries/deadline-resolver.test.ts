import { describe, expect, it } from 'vitest';
import type { ActionItem, DeadlineKind } from '../library/meeting';
import { resolveDeadline, withResolvedDeadlines } from './deadline-resolver';

// 2026-11-04 is a Wednesday.
const WEDNESDAY = '2026-11-04T10:00:00.0000000-05:00';
const FRIDAY = '2026-11-06T10:00:00.0000000-05:00';

describe('resolveDeadline', () => {
  it('returns an absolute date as is', () => {
    expect(resolveDeadline({ type: 'date', date: '2026-12-01' }, WEDNESDAY)).toBe('2026-12-01');
  });

  it('resolves a weekday to its next occurrence after the meeting day', () => {
    expect(resolveDeadline({ type: 'weekday', weekday: 'fri' }, WEDNESDAY)).toBe('2026-11-06');
    expect(resolveDeadline({ type: 'weekday', weekday: 'mon' }, WEDNESDAY)).toBe('2026-11-09');
    expect(resolveDeadline({ type: 'weekday', weekday: 'thu' }, WEDNESDAY)).toBe('2026-11-05');
  });

  it('moves the same weekday a full week ahead', () => {
    expect(resolveDeadline({ type: 'weekday', weekday: 'fri' }, FRIDAY)).toBe('2026-11-13');
    expect(resolveDeadline({ type: 'weekday', weekday: 'wed' }, WEDNESDAY)).toBe('2026-11-11');
  });

  it('adds days across month and year ends', () => {
    expect(resolveDeadline({ type: 'in_days', days: 3 }, '2026-11-29T09:00:00+00:00')).toBe(
      '2026-12-02',
    );
    expect(resolveDeadline({ type: 'in_days', days: 2 }, '2026-12-31T09:00:00+00:00')).toBe(
      '2027-01-02',
    );
    expect(resolveDeadline({ type: 'in_days', days: 0 }, WEDNESDAY)).toBe('2026-11-04');
    expect(resolveDeadline({ type: 'weekday', weekday: 'mon' }, '2026-12-31T09:00:00+00:00')).toBe(
      '2027-01-04',
    );
    expect(resolveDeadline({ type: 'in_days', days: 1 }, '2028-02-28T09:00:00+00:00')).toBe(
      '2028-02-29',
    );
  });

  it('resolves next week as seven days after the meeting', () => {
    expect(resolveDeadline({ type: 'next_week' }, WEDNESDAY)).toBe('2026-11-11');
  });

  it('uses the meeting offset, not the machine zone, near midnight', () => {
    // 23:30 at -05:00 is 04:30 UTC on Nov 7, but the meeting day is Friday Nov 6.
    const late = '2026-11-06T23:30:00-05:00';
    expect(resolveDeadline({ type: 'in_days', days: 0 }, late)).toBe('2026-11-06');
    expect(resolveDeadline({ type: 'weekday', weekday: 'sat' }, late)).toBe('2026-11-07');
    // 00:30 at +09:00 is still Nov 5 in UTC, but Nov 6 for the meeting.
    expect(resolveDeadline({ type: 'in_days', days: 0 }, '2026-11-06T00:30:00+09:00')).toBe(
      '2026-11-06',
    );
  });

  it('leaves next meeting open unless the next session date is known', () => {
    expect(resolveDeadline({ type: 'next_meeting' }, WEDNESDAY)).toBeUndefined();
    expect(resolveDeadline({ type: 'next_meeting' }, WEDNESDAY, '2026-11-11')).toBe('2026-11-11');
    expect(resolveDeadline({ type: 'next_meeting' }, WEDNESDAY, 'next week')).toBeUndefined();
  });

  it('never invents a date for unknown kinds or an unreadable meeting date', () => {
    expect(resolveDeadline({ type: 'unknown' }, WEDNESDAY)).toBeUndefined();
    expect(resolveDeadline({ type: 'next_week' }, 'not a date')).toBeUndefined();
  });
});

describe('withResolvedDeadlines', () => {
  const kind = (k: DeadlineKind) => k;

  it('fills missing dates and keeps confirmed ones and items without deadlines', () => {
    const items: ActionItem[] = [
      { text: 'a', isDone: false },
      {
        text: 'b',
        isDone: false,
        deadline: { quote: 'el viernes', kind: kind({ type: 'weekday', weekday: 'fri' }) },
      },
      {
        text: 'c',
        isDone: true,
        deadline: { quote: 'mañana', kind: kind({ type: 'in_days', days: 1 }), date: '2026-11-20' },
      },
      {
        text: 'd',
        isDone: false,
        deadline: { quote: 'next class', kind: kind({ type: 'next_meeting' }) },
      },
    ];
    const out = withResolvedDeadlines(items, WEDNESDAY, '2026-11-09');
    expect(out[0]).toEqual({ text: 'a', isDone: false });
    expect(out[1]?.deadline?.date).toBe('2026-11-06');
    expect(out[2]?.deadline?.date).toBe('2026-11-20');
    expect(out[3]?.deadline?.date).toBe('2026-11-09');
  });

  it('adds no date key when nothing resolves', () => {
    const out = withResolvedDeadlines(
      [{ text: 'd', isDone: false, deadline: { quote: 'q', kind: { type: 'next_meeting' } } }],
      WEDNESDAY,
    );
    expect(out[0]?.deadline).toEqual({ quote: 'q', kind: { type: 'next_meeting' } });
  });
});
