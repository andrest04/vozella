import { describe, expect, it } from 'vitest';
import { awaitsNextSession, exportableIndexes, type ActionItemDto } from './summary-tab-model';

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
