import { describe, expect, it } from 'vitest';
import type { ActionItem } from '../library/meeting';
import {
  buildSeriesContext,
  MAX_FOLDER_NOTE_CHARS,
  MAX_PRIOR_ITEMS_CHARS,
  type PriorMeetingItems,
} from './series-context';

const item = (text: string, patch: Partial<ActionItem> = {}): ActionItem => ({
  text,
  isDone: false,
  ...patch,
});
const prior = (title: string, recordedAt: string, items: ActionItem[]): PriorMeetingItems => ({
  title,
  recordedAt,
  items,
});

describe('buildSeriesContext', () => {
  it('is null when there is no folder note and no open item', () => {
    expect(buildSeriesContext(null, [])).toBeNull();
    expect(
      buildSeriesContext('  ', [prior('A', '2026-09-01T12:00:00.0000000+00:00', [])]),
    ).toBeNull();
    const done = prior('A', '2026-09-01T12:00:00.0000000+00:00', [item('x', { isDone: true })]);
    expect(buildSeriesContext(null, [done])).toBeNull();
  });

  it('keeps the folder note alone when no meeting has open items', () => {
    expect(buildSeriesContext('  Weekly sync notes ', [])).toEqual({
      folderNote: 'Weekly sync notes',
      priorOpenItems: null,
    });
  });

  it('lists only unfinished items with title, date, owner and deadline', () => {
    const context = buildSeriesContext(null, [
      prior('Standup', '2026-09-01T12:00:00.0000000+00:00', [
        item('Send the deck', {
          owner: 'Ana',
          deadline: {
            quote: 'by Friday',
            kind: { type: 'weekday', weekday: 'fri' },
            date: '2026-09-04',
          },
        }),
        item('Already done', { isDone: true }),
        item('Review the API', { deadline: { quote: 'next week', kind: { type: 'next_week' } } }),
      ]),
    ]);
    expect(context?.priorOpenItems).toBe(
      [
        'Standup (2026-09-01)',
        '- Send the deck — Owner: Ana — Due: 2026-09-04',
        '- Review the API — Due: next week',
      ].join('\n'),
    );
  });

  it('skips meetings whose items are all done and separates the rest with a blank line', () => {
    const context = buildSeriesContext(null, [
      prior('B', '2026-09-08T12:00:00.0000000+00:00', [item('one')]),
      prior('Skipped', '2026-09-05T12:00:00.0000000+00:00', [item('d', { isDone: true })]),
      prior('A', '2026-09-01T12:00:00.0000000+00:00', [item('two')]),
    ]);
    expect(context?.priorOpenItems).toBe('B (2026-09-08)\n- one\n\nA (2026-09-01)\n- two');
  });

  it('bounds the folder note and the open items text', () => {
    const long = 'x'.repeat(MAX_FOLDER_NOTE_CHARS * 2);
    expect(buildSeriesContext(long, [])?.folderNote?.length).toBeLessThanOrEqual(
      MAX_FOLDER_NOTE_CHARS,
    );
    const many = Array.from({ length: 200 }, (_, i) =>
      item(`task ${String(i)} ${'y'.repeat(100)}`),
    );
    const context = buildSeriesContext(null, [
      prior('A', '2026-09-01T12:00:00.0000000+00:00', many),
      prior('B', '2026-09-02T12:00:00.0000000+00:00', many),
    ]);
    expect(context?.priorOpenItems?.length).toBeLessThanOrEqual(MAX_PRIOR_ITEMS_CHARS);
  });
});
