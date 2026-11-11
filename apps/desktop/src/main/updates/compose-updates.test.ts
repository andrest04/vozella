import { describe, expect, it, vi } from 'vitest';
import { ExitGateRegistry, type Logger } from '@vozella/core';
import type { IpcMainLike } from '../ipc/ipc-server';
import { composeUpdates } from './compose-updates';
import type { UpdaterPort, UpdateTimers } from './update-controller';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function port(): UpdaterPort & { downloaded?: (version: string) => void } {
  const fake: UpdaterPort & { downloaded?: (version: string) => void } = {
    onAvailable: () => undefined,
    onNotAvailable: () => undefined,
    onProgress: () => undefined,
    onDownloaded: (listener) => {
      fake.downloaded = listener;
    },
    onError: () => undefined,
    check: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  };
  return fake;
}

const timers: UpdateTimers = { after: () => () => undefined, every: () => () => undefined };

function setup(isPackaged: boolean, env: Record<string, string> = {}, createPort = port) {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const broadcast = vi.fn();
  const create = vi.fn(createPort);
  const log = logger();
  composeUpdates({
    isPackaged,
    env,
    currentVersion: '0.9.7',
    logger: log,
    server: { ipc, isTrusted: () => true, logger: log },
    gates: new ExitGateRegistry(),
    approveQuit: () => undefined,
    broadcast,
    createPort: create,
    timers,
  });
  const state = async () =>
    ((await handlers.get('updates.getState')?.({} as never, {})) as { value: unknown }).value;
  return { create, broadcast, state, log, registered: [...handlers.keys()] };
}

describe('composeUpdates', () => {
  it('never creates the updater in dev or e2e, yet serves an idle state', async () => {
    for (const t of [setup(false), setup(true, { VOZELLA_E2E: '1' })]) {
      expect(t.create).not.toHaveBeenCalled();
      expect(t.registered).toEqual(['updates.getState', 'updates.install']);
      expect(await t.state()).toEqual({ currentVersion: '0.9.7', update: { status: 'idle' } });
    }
  });

  it('runs in a packaged release and pushes each change to the windows', () => {
    const fake = port();
    const t = setup(true, {}, () => fake);
    expect(t.create).toHaveBeenCalledTimes(1);
    fake.downloaded?.('0.10.0');
    expect(t.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'updates.stateChanged' }),
      { currentVersion: '0.9.7', update: { status: 'ready', version: '0.10.0' } },
    );
  });

  it('keeps the app running when the updater cannot be created', async () => {
    const t = setup(true, {}, () => {
      throw new Error('no app-update.yml');
    });
    expect(t.log.error).toHaveBeenCalledTimes(1);
    expect(await t.state()).toEqual({ currentVersion: '0.9.7', update: { status: 'idle' } });
  });
});
