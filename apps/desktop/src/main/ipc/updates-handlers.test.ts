import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@vozella/core';
import type { IpcEventLike } from '../security/trusted-origin';
import { disabledUpdates, type UpdatesService } from '../updates/update-controller';
import type { IpcMainLike } from './ipc-server';
import { registerUpdatesHandlers } from './updates-handlers';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};

function setup(updates: UpdatesService, trusted = true) {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  registerUpdatesHandlers({ server: { ipc, isTrusted: () => trusted, logger: logger() }, updates });
  const call = async (name: string, input: unknown = {}) =>
    (await handlers.get(name)?.(event as never, input)) as {
      ok: boolean;
      value?: unknown;
      error?: { code: string };
    };
  return { call, registered: [...handlers.keys()] };
}

describe('updates handlers', () => {
  it('registers the state, install and check requests', () => {
    expect(setup(disabledUpdates('1.0.0')).registered).toEqual([
      'updates.getState',
      'updates.install',
      'updates.check',
    ]);
  });

  it('serves the state with the running and the new version', async () => {
    const updates: UpdatesService = {
      state: () => ({ currentVersion: '0.9.7', update: { status: 'ready', version: '0.10.0' } }),
      install: vi.fn(),
      check: vi.fn(),
    };
    expect(await setup(updates).call('updates.getState')).toEqual({
      ok: true,
      value: { currentVersion: '0.9.7', update: { status: 'ready', version: '0.10.0' } },
    });
  });

  it('passes the install outcome through, a refusal included', async () => {
    const install = vi.fn(() => Promise.resolve({ status: 'refused' as const }));
    const t = setup({ ...disabledUpdates('1'), install });
    expect(await t.call('updates.install')).toEqual({ ok: true, value: { status: 'refused' } });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('rejects an input with extra fields without installing', async () => {
    const install = vi.fn();
    const t = setup({ ...disabledUpdates('1'), install });
    const result = await t.call('updates.install', { now: true });
    expect(result.ok).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('refuses an untrusted sender', async () => {
    const install = vi.fn();
    const t = setup({ ...disabledUpdates('1'), install }, false);
    expect((await t.call('updates.install')).error?.code).toBe('untrusted-sender');
    expect(install).not.toHaveBeenCalled();
  });

  it('passes the check outcome through', async () => {
    const check = vi.fn(() => ({ status: 'started' as const }));
    const t = setup({ ...disabledUpdates('1'), check });
    expect(await t.call('updates.check')).toEqual({ ok: true, value: { status: 'started' } });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('answers a check in a build without updates with disabled', async () => {
    expect(await setup(disabledUpdates('1')).call('updates.check')).toEqual({
      ok: true,
      value: { status: 'disabled' },
    });
  });

  it('rejects a check input with extra fields without checking', async () => {
    const check = vi.fn(() => ({ status: 'started' as const }));
    const t = setup({ ...disabledUpdates('1'), check });
    expect((await t.call('updates.check', { force: true })).ok).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses a check from an untrusted sender', async () => {
    const check = vi.fn(() => ({ status: 'started' as const }));
    const t = setup({ ...disabledUpdates('1'), check }, false);
    expect((await t.call('updates.check')).error?.code).toBe('untrusted-sender');
    expect(check).not.toHaveBeenCalled();
  });
});
