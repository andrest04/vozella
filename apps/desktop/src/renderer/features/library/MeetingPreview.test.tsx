// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, meetingRecord } from './library-test-kit';
import { MeetingPreview } from './MeetingPreview';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 6, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MeetingPreview action items', () => {
  it('shows a confirmed date beside the item and nothing for an undated one', () => {
    const record = meetingRecord('m1', 'Weekly sync', '2026-11-04T10:00:00+01:00', {
      actionItems: [
        {
          text: 'Send the slides',
          isDone: false,
          deadline: {
            quote: 'el viernes',
            kind: { type: 'weekday', weekday: 'fri' },
            date: '2026-11-13',
          },
        },
        {
          text: 'Bring the progress',
          isDone: false,
          deadline: { quote: 'next class', kind: { type: 'next_meeting' } },
        },
      ],
    });
    render(
      <Providers>
        <MeetingPreview state={{ record, phase: 'ready' }} preferredTab={null} onOpen={vi.fn()} />
      </Providers>,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Send the slides');
    expect(items[0]).toHaveTextContent('Fri 13 Nov');
    expect(items[1]).toHaveTextContent(/^Bring the progress$/);
  });
});
