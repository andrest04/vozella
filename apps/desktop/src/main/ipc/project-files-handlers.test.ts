import { requestChannels, type RequestName } from '@vozella/contracts';
import { InMemoryProjectFileStore, type Logger } from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import type { IpcEventLike } from '../security/trusted-origin';
import type { IpcMainLike } from './ipc-server';
import { registerProjectFileHandlers } from './project-files-handlers';

const PROJECT = '9f1c0000-0000-4000-8000-000000000001';
const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};

function setup() {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const files = new InMemoryProjectFileStore();
  files.registerSource('C:/a.txt', { name: 'a.txt', kind: 'text', sizeBytes: 5, text: 'alpha' });
  const events: unknown[] = [];
  registerProjectFileHandlers({
    server: { ipc, logger: logger(), isTrusted: () => true },
    library: { projects: {} as never, projectFiles: files },
    broadcast: (channel, payload) => events.push({ name: channel.name, payload }),
    dialogs: {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: ['C:/a.txt'] }),
      showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
    },
    logger: logger(),
  });
  const call = (name: RequestName, input: unknown): unknown => {
    const handler = handlers.get(requestChannels[name].name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(event as never, input);
  };
  return { call, files, events };
}

describe('project file handlers', () => {
  it('picks, adds and removes through the controller', async () => {
    const { call, events } = setup();
    const picked = (await call('projects.files.pick', { projectId: PROJECT })) as {
      ok: boolean;
      value: { results: { ok: boolean; file?: { id: string } }[] };
    };
    expect(picked.ok).toBe(true);
    const fileId = picked.value.results[0]?.file?.id ?? '';
    expect(fileId).not.toBe('');
    const removed = await call('projects.files.remove', { projectId: PROJECT, fileId });
    expect(removed).toMatchObject({ ok: true, value: { removed: true } });
    expect(events).toHaveLength(2);
  });

  it('rejects a path-shaped project id before it reaches the store', async () => {
    const { call, files } = setup();
    const result = await call('projects.files.add', { projectId: '../x', paths: ['C:/a.txt'] });
    expect(result).toMatchObject({ ok: false });
    expect(await files.list('../x')).toEqual([]);
  });
});
