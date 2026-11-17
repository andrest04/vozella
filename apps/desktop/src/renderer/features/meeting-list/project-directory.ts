import type { ProjectListItemDto, SkippedProjectDto, StorageStateDto } from '@vozella/contracts';
import { useEffect } from 'react';
import { create } from 'zustand';

/** What the projects store knows about the meetings that belong to no project. */
export interface NoProjectSummaryState {
  readonly meetingCount: number;
  readonly lastActivityAt: string | null;
}

export interface ProjectDirectoryState {
  /** `loading` until the first answer; `failed` when the last load threw (the old data stays). */
  readonly status: 'loading' | 'ready' | 'failed';
  readonly projects: readonly ProjectListItemDto[];
  readonly noProject: NoProjectSummaryState;
  readonly skipped: readonly SkippedProjectDto[];
  readonly storage: StorageStateDto;
}

const INITIAL: ProjectDirectoryState = {
  status: 'loading',
  projects: [],
  noProject: { meetingCount: 0, lastActivityAt: null },
  skipped: [],
  storage: { status: 'ready' },
};

/**
 * The one list of projects the window shares: the Projects tab, the Library filter, the move
 * popover and the record destination all read it, so a rename shows everywhere at once.
 */
export const useProjectDirectory = create<ProjectDirectoryState>(() => INITIAL);

const { setState: set } = useProjectDirectory;

/** Coalesces the burst of changes one operation broadcasts. */
export const DIRECTORY_REFRESH_DEBOUNCE_MS = 150;

let loadSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<void> {
  loadSeq += 1;
  const seq = loadSeq;
  try {
    const result = await window.vozella.invoke('projects.list', {});
    if (seq !== loadSeq) return;
    set({
      status: 'ready',
      projects: result.projects,
      noProject: result.noProject,
      skipped: result.skipped,
      storage: result.storage,
    });
  } catch {
    if (seq === loadSeq) set({ status: 'failed' });
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void load();
  }, DIRECTORY_REFRESH_DEBOUNCE_MS);
}

/** Loads now, for a caller that just changed something and wants the answer without waiting. */
export function refreshProjectDirectory(): Promise<void> {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
  return load();
}

let connections = 0;
let disconnect: (() => void) | null = null;

/**
 * Connected by every screen that shows projects, and once by the shell. The first connection
 * loads and listens; the last one stops and forgets, so nothing outlives its screens.
 */
export function connectProjectDirectory(): () => void {
  connections += 1;
  if (connections === 1) {
    const offProjects = window.vozella.on('projects.changed', scheduleRefresh);
    // Meeting counts and the last activity date move with the meetings.
    const offLibrary = window.vozella.on('library.changed', scheduleRefresh);
    void load();
    disconnect = () => {
      offProjects();
      offLibrary();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
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

/** Subscribes a component to the directory for as long as it is mounted. */
export function useConnectedProjectDirectory(): ProjectDirectoryState {
  useEffect(() => connectProjectDirectory(), []);
  return useProjectDirectory();
}
