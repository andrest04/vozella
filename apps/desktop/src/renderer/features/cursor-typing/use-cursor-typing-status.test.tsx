// @vitest-environment jsdom
import type { CursorTypingStatusDto } from '@vozella/contracts';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCursorTypingStatus } from './use-cursor-typing-status';

type Listener = (payload: CursorTypingStatusDto) => void;

const status = (over: Partial<CursorTypingStatusDto> = {}): CursorTypingStatusDto => ({
  state: { status: 'off' },
  shortcut: { status: 'registered', accelerator: 'CommandOrControl+Alt+Space' },
  lastRefusal: null,
  ...over,
});

function install(answer: () => Promise<unknown>) {
  const listeners = new Set<Listener>();
  const off = vi.fn();
  const invoke = vi.fn((name: string) =>
    name === 'cursorTyping.getState' ? answer() : Promise.reject(new Error(name)),
  );
  Object.defineProperty(window, 'vozella', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: (name: string, listener: Listener) => {
        if (name !== 'cursorTyping.state') return () => undefined;
        listeners.add(listener);
        return () => {
          off();
          listeners.delete(listener);
        };
      },
    },
  });
  return {
    invoke,
    off,
    listeners,
    emit: (payload: CursorTypingStatusDto) => {
      act(() => {
        for (const listener of listeners) listener(payload);
      });
    },
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

describe('useCursorTypingStatus', () => {
  it('asks for the current status once, then follows pushes', async () => {
    const bridge = install(() => Promise.resolve(status()));
    const { result } = renderHook(() => useCursorTypingStatus());
    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current?.shortcut.status).toBe('registered');
    });
    expect(bridge.invoke).toHaveBeenCalledWith('cursorTyping.getState', {});
    const armed = status({
      state: { status: 'armed', source: 'others', processName: 'chrome.exe', warning: null },
    });
    bridge.emit(armed);
    expect(result.current).toEqual(armed);
  });

  it('keeps a pushed status over a late answer to the first ask', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const bridge = install(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { result } = renderHook(() => useCursorTypingStatus());
    const pushed = status({ lastRefusal: 'own-window' });
    bridge.emit(pushed);
    await act(async () => {
      answer(status());
      await Promise.resolve();
    });
    expect(result.current).toEqual(pushed);
  });

  it('stays null when the answer is missing or malformed', async () => {
    install(() => Promise.resolve({ done: true }));
    const { result } = renderHook(() => useCursorTypingStatus());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });

  it('stays null when the ask fails', async () => {
    install(() => Promise.reject(new Error('no handler')));
    const { result } = renderHook(() => useCursorTypingStatus());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });

  it('stops listening on unmount', () => {
    const bridge = install(() => Promise.resolve(status()));
    const { unmount } = renderHook(() => useCursorTypingStatus());
    expect(bridge.listeners.size).toBe(1);
    unmount();
    expect(bridge.off).toHaveBeenCalledTimes(1);
    expect(bridge.listeners.size).toBe(0);
  });
});
