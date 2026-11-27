import { describe, expect, it, vi } from 'vitest';
import type { CursorTypingStatusDto } from '@vozella/contracts';
import type { Logger } from '@vozella/core';
import type { IpcEventLike } from '../security/trusted-origin';
import { registerCursorTypingHandlers, type CursorTypingService } from './cursor-typing-handlers';
import type { IpcMainLike } from './ipc-server';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};

const off: CursorTypingStatusDto = {
  state: { status: 'off' },
  shortcut: { status: 'inactive', accelerator: 'CommandOrControl+Alt+Space' },
  lastRefusal: null,
};

function setup(service: CursorTypingService) {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  registerCursorTypingHandlers({
    server: { ipc, isTrusted: () => true, logger: logger() },
    controller: service,
  });
  const call = async (name: string, input: unknown = {}) =>
    (await handlers.get(name)?.(event as never, input)) as { ok: boolean; value?: unknown };
  return { call, registered: [...handlers.keys()] };
}

describe('cursor typing handlers', () => {
  it('registers the state and toggle requests', () => {
    expect(setup({ status: () => off, toggle: vi.fn(() => null) }).registered).toEqual([
      'cursorTyping.getState',
      'cursorTyping.toggle',
    ]);
  });

  it('serves the status', async () => {
    expect(
      await setup({ status: () => off, toggle: vi.fn(() => null) }).call('cursorTyping.getState'),
    ).toEqual({
      ok: true,
      value: off,
    });
  });

  it('toggles and answers the arm outcome with the status after it', async () => {
    let status = off;
    const toggle = vi.fn(() => {
      status = { ...off, lastRefusal: 'own-window' };
      return { ok: false as const, reason: 'own-window' as const };
    });
    const result = await setup({ status: () => status, toggle }).call('cursorTyping.toggle');
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: {
        arm: { ok: false, reason: 'own-window' },
        status: { ...off, lastRefusal: 'own-window' },
      },
    });
  });

  it('rejects a toggle input with extra fields without toggling', async () => {
    const toggle = vi.fn(() => null);
    const result = await setup({ status: () => off, toggle }).call('cursorTyping.toggle', {
      source: 'all',
    });
    expect(result.ok).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });
});
