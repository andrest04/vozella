import { requestChannels } from '@vozella/contracts';
import {
  InMemoryChatThreadRepository,
  InMemoryProjectContextSource,
  InMemoryProjectFileStore,
  InMemoryProjectRepository,
  InMemoryStorageState,
  ProjectService,
  type Logger,
  type MeetingBusyProbe,
  type MeetingRepository,
} from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { vi } from 'vitest';
import type { IpcMainLike, IpcServerDeps } from './ipc/ipc-server';
import type { WindowDialogs } from './window-dialogs';

/** Test-only doubles shared by the `compose-*.test.ts` files. */
export const silentLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** An ipcMain double that records the channels a compose function registers. */
export function recordingIpc(): { server: IpcServerDeps; channels: string[] } {
  const channels: string[] = [];
  const ipc: IpcMainLike = {
    handle: (name) => {
      channels.push(name);
    },
  };
  return { server: { ipc, logger: silentLogger(), isTrusted: () => true }, channels };
}

/** Every request channel of the contracts whose name starts with one of the prefixes. */
export const requestChannelsWithPrefix = (...prefixes: string[]): string[] =>
  Object.keys(requestChannels)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .sort();

export const noDialogs = (): WindowDialogs => ({
  showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true, filePath: '' })),
});

/** The project services of a library runtime, backed by the in-memory fakes of core. */
export function inMemoryProjectLibrary(): Pick<
  LibraryRuntime,
  'projects' | 'projectService' | 'projectFiles' | 'chatThreads' | 'projectContext'
> & { readonly state: InMemoryStorageState } {
  const state = new InMemoryStorageState();
  const projects = new InMemoryProjectRepository({ state });
  const projectFiles = new InMemoryProjectFileStore(state);
  const chatThreads = new InMemoryChatThreadRepository(state);
  const busy: MeetingBusyProbe = { isBusy: () => false };
  const projectService = new ProjectService({
    projects,
    meetings: {} as MeetingRepository,
    files: projectFiles,
    threads: chatThreads,
    busy,
  });
  return {
    state,
    projects,
    projectService,
    projectFiles,
    chatThreads,
    projectContext: new InMemoryProjectContextSource(),
  };
}
