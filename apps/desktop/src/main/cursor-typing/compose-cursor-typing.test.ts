import { InMemorySettingsStore, type Logger } from '@vozella/core';
import { FakeTextInjector } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMainLike } from '../ipc/ipc-server';
import { changesCursorTyping, composeCursorTyping } from './compose-cursor-typing';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function compose(options: { fakeNative: boolean; loadInjector: () => never | FakeTextInjector }) {
  const handlers = new Map<string, unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const stops: (() => void)[] = [];
  const log = logger();
  const shortcuts = { register: vi.fn(() => true), unregister: vi.fn() };
  const composed = composeCursorTyping({
    fakeNative: options.fakeNative,
    loadInjector: options.loadInjector,
    transcription: { onLiveUpdate: () => () => undefined, liveMicDominantShare: () => null },
    settings: new InMemorySettingsStore(),
    shortcuts,
    broadcast: vi.fn(),
    logger: log,
    server: { ipc, isTrusted: () => true, logger: log },
    stopOnExit: (stop) => stops.push(stop),
  });
  return { ...composed, handlers, stops, log, shortcuts };
}

describe('composeCursorTyping', () => {
  it('uses the fake injector in the fake native build and never loads the addon', () => {
    const loadInjector = vi.fn(() => {
      throw new Error('must not load');
    });
    const t = compose({ fakeNative: true, loadInjector });
    expect(t.injector).toBeInstanceOf(FakeTextInjector);
    expect(loadInjector).not.toHaveBeenCalled();
    expect([...t.handlers.keys()]).toEqual(['cursorTyping.getState', 'cursorTyping.toggle']);
  });

  it('without the addon every arm is refused for lack of a target', async () => {
    const t = compose({
      fakeNative: false,
      loadInjector: () => {
        throw new Error('type_text is missing');
      },
    });
    expect(t.log.warn).toHaveBeenCalled();
    await t.controller.refreshSettings();
    t.controller.setRecording(true);
    expect(t.controller.toggle()).toEqual({ ok: false, reason: 'no-target' });
  });

  it('lets go of the shortcut on quit', async () => {
    const t = compose({ fakeNative: true, loadInjector: () => new FakeTextInjector() });
    await t.controller.refreshSettings();
    t.controller.setRecording(true);
    expect(t.shortcuts.register).toHaveBeenCalledTimes(1);
    for (const stop of t.stops) stop();
    expect(t.shortcuts.unregister).toHaveBeenCalledWith('CommandOrControl+Alt+Space');
  });

  it('names a saved patch that touches its settings', () => {
    expect(changesCursorTyping({ cursorTypingShortcut: 'Alt+F9' })).toBe(true);
    expect(changesCursorTyping({ cursorTypingEnabled: false })).toBe(true);
    expect(changesCursorTyping({ uiLanguage: 'en' })).toBe(false);
  });
});
