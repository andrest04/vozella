import type { FailureReasonDto, MeetingListItemDto } from '@vozella/contracts';
import { create } from 'zustand';
import { NO_FILTERS, type MeetingFilters } from './meeting-filters';

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface LoadProblem {
  readonly reason: FailureReasonDto;
  readonly message: string | undefined;
}

export interface MeetingListState {
  readonly isLoading: boolean;
  readonly problem: LoadProblem | null;
  /** Files the last load could not read as meetings, with the reason. */
  readonly skipped: readonly SkippedFile[];
  /** Every meeting of the library: a list shows the part its scope names. */
  readonly meetings: readonly MeetingListItemDto[];
  /** Kept across scopes and meetings for this session. Never written to disk. */
  readonly filters: MeetingFilters;
  /** The row the keyboard is on. It survives leaving the route, so coming back lands on it. */
  readonly cursorId: string | null;
  readonly scrollOffset: number;
}

const INITIAL: MeetingListState = {
  isLoading: true,
  problem: null,
  skipped: [],
  meetings: [],
  filters: NO_FILTERS,
  cursorId: null,
  scrollOffset: 0,
};

export const useMeetingListStore = create<MeetingListState>(() => INITIAL);

const { setState: set } = useMeetingListStore;

/** Coalesces the burst of changes one operation broadcasts: a load costs real time at 3,000. */
export const REFRESH_DEBOUNCE_MS = 150;

let loadSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

async function load(firstLoad: boolean): Promise<void> {
  cancelScheduledRefresh();
  loadSeq += 1;
  const seq = loadSeq;
  if (firstLoad) set({ isLoading: true });
  try {
    const result = await window.vozella.invoke('library.load', {});
    if (seq !== loadSeq) return;
    if (!result.ok) {
      set({ problem: { reason: result.reason, message: result.message } });
      return;
    }
    set({ problem: null, meetings: result.meetings, skipped: result.skipped });
  } finally {
    if (seq === loadSeq) set({ isLoading: false });
  }
}

/** Loads now. */
export function refreshMeetingList(): Promise<void> {
  return load(false);
}

function scheduleRefresh(): void {
  cancelScheduledRefresh();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void load(false);
  }, REFRESH_DEBOUNCE_MS);
}

function whenIdle(run: () => void): () => void {
  if ('requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(run, { timeout: 500 });
    return () => {
      window.cancelIdleCallback(handle);
    };
  }
  const timer = setTimeout(run, 0);
  return () => {
    clearTimeout(timer);
  };
}

let connections = 0;
let disconnect: (() => void) | null = null;

/** Connected once from the shell. The first load waits for idle, because it runs on every route. */
export function connectMeetingList(): () => void {
  connections += 1;
  if (connections === 1) {
    const offChanged = window.vozella.on('library.changed', scheduleRefresh);
    const cancelIdle = whenIdle(() => {
      void load(true);
    });
    disconnect = () => {
      offChanged();
      cancelIdle();
      cancelScheduledRefresh();
      loadSeq += 1;
      set(INITIAL, true);
    };
  }
  return () => {
    connections -= 1;
    if (connections === 0) {
      disconnect?.();
      disconnect = null;
    }
  };
}

/** The list changes under the scroll position, so it starts again from the top. */
export function setFilters(filters: MeetingFilters): void {
  set({ filters, scrollOffset: 0 });
}

export function setCursor(cursorId: string | null): void {
  set({ cursorId });
}

/** Nothing renders from this: it is read once, when the list comes back. */
export function rememberScroll(scrollOffset: number): void {
  set({ scrollOffset });
}

/** Another list starts at the top with no row chosen. */
export function resetPosition(): void {
  set({ cursorId: null, scrollOffset: 0 });
}
