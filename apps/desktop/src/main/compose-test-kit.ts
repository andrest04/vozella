import { requestChannels } from '@vozella/contracts';
import type { Logger } from '@vozella/core';
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
