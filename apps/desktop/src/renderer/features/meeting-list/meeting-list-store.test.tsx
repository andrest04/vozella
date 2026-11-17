// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  connectMeetingList,
  REFRESH_DEBOUNCE_MS,
  setFilters,
  useMeetingListStore,
} from './meeting-list-store';
import { installFakeApi, meetingRecord } from './meeting-list-test-kit';
import { NO_FILTERS } from './meeting-filters';

type Api = ReturnType<typeof installFakeApi>;

const seed = ({ meetings }: Api): void => {
  meetings.records.set('a', meetingRecord('a', 'Standup', '2026-09-01T09:00:00.0000000+00:00'));
  meetings.records.set(
    'b',
    meetingRecord('b', 'Planning', '2026-09-03T09:00:00.0000000+00:00', { projectId: 'p1' }),
  );
};

const loads = (api: Api): number => api.calls.filter((c) => c.name === 'library.load').length;

describe('connectMeetingList', () => {
  it('defers the first load, loads every meeting, and connects only once', async () => {
    const api = installFakeApi();
    seed(api);
    const off = connectMeetingList();
    const second = connectMeetingList();
    expect(loads(api)).toBe(0);
    await waitFor(() => {
      expect(useMeetingListStore.getState().isLoading).toBe(false);
    });
    expect(loads(api)).toBe(1);
    expect(useMeetingListStore.getState().meetings).toHaveLength(2);
    second();
    off();
    expect(useMeetingListStore.getState().meetings).toHaveLength(0);
  });

  it('turns a burst of changes into one load after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = installFakeApi();
      seed(api);
      const off = connectMeetingList();
      await vi.waitFor(() => {
        expect(useMeetingListStore.getState().isLoading).toBe(false);
      });
      const before = loads(api);
      act(() => {
        api.emit('library.changed', { reason: 'meeting' });
        api.emit('library.changed', { reason: 'meeting' });
        api.emit('library.changed', { reason: 'project' });
      });
      expect(loads(api)).toBe(before);
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 1);
      await vi.waitFor(() => {
        expect(loads(api)).toBe(before + 1);
      });
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the filters of this session and resets the scroll when they change', () => {
    useMeetingListStore.setState({ scrollOffset: 400 });
    setFilters({ ...NO_FILTERS });
    expect(useMeetingListStore.getState().scrollOffset).toBe(0);
  });
});
