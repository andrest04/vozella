// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  connectLibrary,
  directCounts,
  REFRESH_DEBOUNCE_MS,
  useLibraryStore,
} from './meeting-list-store';
import { folderRecord, installFakeApi, meetingRecord } from './meeting-list-test-kit';

const UNI = '11111111-1111-4111-8111-111111111111';
const CALC = '22222222-2222-4222-8222-222222222222';

type Api = ReturnType<typeof installFakeApi>;

const seed = ({ meetings, folders }: Api): void => {
  folders.folders = [folderRecord(UNI, 'Universidad'), folderRecord(CALC, 'Calculo', UNI)];
  meetings.records.set('a', meetingRecord('a', 'Standup', '2026-09-01T09:00:00.0000000+00:00'));
  meetings.records.set(
    'b',
    meetingRecord('b', 'Planning', '2026-09-03T09:00:00.0000000+00:00', { projectId: UNI }),
  );
  meetings.records.set(
    'c',
    meetingRecord('c', 'Review', '2026-09-02T09:00:00.0000000+00:00', { projectId: 'gone' }),
  );
};

const loads = (api: Api): number => api.calls.filter((c) => c.name === 'library.load').length;

describe('directCounts', () => {
  it('counts each container on its own, with unknown folders in the Inbox', () => {
    const counts = directCounts(
      [folderRecord(UNI, 'Universidad'), folderRecord(CALC, 'Calculo', UNI)] as never,
      [
        { projectId: null },
        { projectId: 'gone' },
        { projectId: UNI },
        { projectId: CALC },
        { projectId: CALC },
      ] as never,
    );
    expect(counts.all).toBe(5);
    expect(counts.inbox).toBe(2);
    expect(counts.byFolder.get(UNI)).toBe(1);
    expect(counts.byFolder.get(CALC)).toBe(2);
  });
});

describe('connectLibrary', () => {
  it('defers the first load, opens on All, and connects only once', async () => {
    const api = installFakeApi();
    seed(api);
    const off = connectLibrary();
    const second = connectLibrary();
    expect(loads(api)).toBe(0);
    await waitFor(() => {
      expect(useLibraryStore.getState().isLoading).toBe(false);
    });
    expect(loads(api)).toBe(1);
    expect(useLibraryStore.getState().view).toEqual({ kind: 'all' });
    expect(useLibraryStore.getState().meetings).toHaveLength(3);
    second();
    off();
    expect(useLibraryStore.getState().meetings).toHaveLength(0);
  });

  it('turns a burst of changes into one load after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = installFakeApi();
      seed(api);
      const off = connectLibrary();
      await vi.waitFor(() => {
        expect(useLibraryStore.getState().isLoading).toBe(false);
      });
      const before = loads(api);
      act(() => {
        api.emit('library.changed', { reason: 'meeting' });
        api.emit('library.changed', { reason: 'meeting' });
        api.emit('library.changed', { reason: 'folder' });
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

  it('restores a stored folder, and lands on the Inbox when that folder is gone', async () => {
    const api = installFakeApi();
    seed(api);
    api.workspace.publishSelectedProject('deleted-folder');
    const off = connectLibrary();
    await waitFor(() => {
      expect(useLibraryStore.getState().isLoading).toBe(false);
    });
    expect(useLibraryStore.getState().view).toEqual({ kind: 'inbox' });
    off();
  });
});
