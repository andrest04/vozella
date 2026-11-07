import { describe, expect, it } from 'vitest';
import {
  awaitsNextSession,
  exportableIndexes,
  formatDueDate,
  type ActionItemDto,
} from './summary-tab-model';

const NOW = new Date(2026, 10, 6).getTime();

describe('formatDueDate', () => {
  it('shows a short local weekday, day and month without the year in the current year', () => {
    expect(formatDueDate('2026-11-13', 'en', NOW)).toBe('Fri 13 Nov');
    expect(formatDueDate('2026-11-13', 'es', NOW)).toBe('vie 13 nov');
  });

  it('adds the year when the date is in another year', () => {
    expect(formatDueDate('2027-01-08', 'en', NOW)).toBe('Fri 8 Jan 2027');
  });

  it('gives nothing for a value that is not a calendar day', () => {
    expect(formatDueDate('2026-02-30', 'en', NOW)).toBe('');
    expect(formatDueDate('soon', 'en', NOW)).toBe('');
  });
});

describe('action item deadline helpers', () => {
  const items: ActionItemDto[] = [
    {
      text: 'a',
      isDone: false,
      deadline: { quote: 'Friday', kind: { type: 'weekday', weekday: 'fri' }, date: '2026-11-13' },
    },
    {
      text: 'b',
      isDone: true,
      deadline: { quote: 'Monday', kind: { type: 'weekday', weekday: 'mon' }, date: '2026-11-09' },
    },
    { text: 'c', isDone: false, deadline: { quote: 'next class', kind: { type: 'next_meeting' } } },
    { text: 'd', isDone: false },
  ];

  it('exports only open items that have a date', () => {
    expect(exportableIndexes(items)).toEqual([0]);
  });

  it('waits for the next session only on an undated next_meeting item', () => {
    expect(awaitsNextSession(items)).toBe(true);
    expect(awaitsNextSession(items.slice(0, 2))).toBe(false);
  });
});
