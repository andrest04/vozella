import type { Logger } from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import {
  HIDDEN_LAUNCH_ARG,
  isHiddenLaunch,
  OpenAtLogin,
  showMainWindowOnReady,
  type LoginItemPort,
} from './open-at-login';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** The OS login items, as Windows keeps them: one entry per exact argument list. */
class FakeLoginItems implements LoginItemPort {
  readonly writes: { enabled: boolean; args: readonly string[] }[] = [];
  constructor(
    private enabled = false,
    private readonly fail = false,
  ) {}
  isEnabled(args: readonly string[]): boolean {
    if (this.fail) throw new Error('registry read failed');
    return this.enabled && args.join(' ') === HIDDEN_LAUNCH_ARG;
  }
  set(enabled: boolean, args: readonly string[]): void {
    if (this.fail) throw new Error('registry write failed');
    this.writes.push({ enabled, args: [...args] });
    this.enabled = enabled;
  }
}

describe('open at login', () => {
  it('a toggle registers the app with the hidden flag, and unregisters it', () => {
    const port = new FakeLoginItems();
    const login = new OpenAtLogin({ port, packaged: true, logger: logger() });
    login.apply(true);
    login.apply(false);
    expect(port.writes).toEqual([
      { enabled: true, args: [HIDDEN_LAUNCH_ARG] },
      { enabled: false, args: [HIDDEN_LAUNCH_ARG] },
    ]);
  });

  it('at start up writes only when Windows disagrees with the setting', () => {
    const port = new FakeLoginItems(true);
    const login = new OpenAtLogin({ port, packaged: true, logger: logger() });
    login.reconcile(true);
    expect(port.writes).toEqual([]);
    login.reconcile(false);
    expect(port.writes).toEqual([{ enabled: false, args: [HIDDEN_LAUNCH_ARG] }]);
    login.reconcile(true);
    expect(port.writes.at(-1)).toEqual({ enabled: true, args: [HIDDEN_LAUNCH_ARG] });
  });

  it('a development build touches nothing (it would register electron.exe) and says so', () => {
    const port = new FakeLoginItems();
    const log = logger();
    const login = new OpenAtLogin({ port, packaged: false, logger: log });
    login.apply(true);
    login.reconcile(true);
    expect(port.writes).toEqual([]);
    expect(log.info).toHaveBeenCalledWith('open at login skipped: not a packaged build', {
      enabled: true,
    });
  });

  it('a failure of the OS call is logged, never thrown', () => {
    const log = logger();
    const login = new OpenAtLogin({
      port: new FakeLoginItems(false, true),
      packaged: true,
      logger: log,
    });
    expect(() => {
      login.apply(true);
    }).not.toThrow();
    expect(() => {
      login.reconcile(true);
    }).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('hidden launch', () => {
  it('is the start Windows makes at login, marked by the flag', () => {
    expect(isHiddenLaunch(['vozella.exe', HIDDEN_LAUNCH_ARG])).toBe(true);
    expect(isHiddenLaunch(['vozella.exe'])).toBe(false);
  });

  it('keeps the main window off screen only for that start', () => {
    const show = (mode: 'production' | 'development' | 'test', argv: string[], env = {}) =>
      showMainWindowOnReady({ mode, env, argv });
    expect(show('production', ['vozella.exe'])).toBe(true);
    expect(show('production', ['vozella.exe', HIDDEN_LAUNCH_ARG])).toBe(false);
    expect(show('development', ['electron', '.'])).toBe(true);
  });

  it('leaves automated runs as they were: hidden unless a test asks to show', () => {
    expect(showMainWindowOnReady({ mode: 'test', env: {}, argv: ['electron'] })).toBe(false);
    expect(
      showMainWindowOnReady({ mode: 'test', env: { VOZELLA_E2E_SHOW: '1' }, argv: ['electron'] }),
    ).toBe(true);
  });
});
