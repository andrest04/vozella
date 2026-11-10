import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@vozella/contracts';
import { ExitGateRegistry, type Logger } from '@vozella/core';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UpdateController,
  disabledUpdates,
  updatesEnabled,
  type UpdaterPort,
  type UpdateTimers,
} from './update-controller';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

class FakeUpdater implements UpdaterPort {
  available?: (version: string) => void;
  notAvailable?: () => void;
  progress?: (percent: number) => void;
  downloaded?: (version: string) => void;
  error?: (error: unknown) => void;
  readonly check = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
  readonly quitAndInstall = vi.fn();
  onAvailable(listener: (version: string) => void) {
    this.available = listener;
  }
  onNotAvailable(listener: () => void) {
    this.notAvailable = listener;
  }
  onProgress(listener: (percent: number) => void) {
    this.progress = listener;
  }
  onDownloaded(listener: (version: string) => void) {
    this.downloaded = listener;
  }
  onError(listener: (error: unknown) => void) {
    this.error = listener;
  }
}

class FakeTimers implements UpdateTimers {
  readonly once: { ms: number; run: () => void; cancelled: boolean }[] = [];
  readonly repeating: { ms: number; run: () => void; cancelled: boolean }[] = [];
  after(ms: number, run: () => void) {
    const timer = { ms, run, cancelled: false };
    this.once.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  every(ms: number, run: () => void) {
    const timer = { ms, run, cancelled: false };
    this.repeating.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
}

function setup(options: { gates?: ExitGateRegistry } = {}) {
  const port = new FakeUpdater();
  const timers = new FakeTimers();
  const log = logger();
  const changes: UpdateState[] = [];
  const approveQuit = vi.fn();
  const controller = new UpdateController({
    port,
    timers,
    logger: log,
    currentVersion: '0.9.7',
    gates: options.gates ?? new ExitGateRegistry(),
    approveQuit,
    onChange: (state) => changes.push(state),
  });
  controller.start();
  return { port, timers, log, changes, approveQuit, controller };
}

describe('UpdateController', () => {
  it('checks once shortly after startup and then every few hours', () => {
    const t = setup();
    expect(t.timers.once.map((timer) => timer.ms)).toEqual([FIRST_CHECK_DELAY_MS]);
    expect(t.timers.repeating.map((timer) => timer.ms)).toEqual([CHECK_INTERVAL_MS]);
    expect(t.port.check).not.toHaveBeenCalled();
    t.timers.once[0]?.run();
    t.timers.repeating[0]?.run();
    expect(t.port.check).toHaveBeenCalledTimes(2);
  });

  it('starts idle with the running version', () => {
    const t = setup();
    expect(t.controller.state()).toEqual({ currentVersion: '0.9.7', update: { status: 'idle' } });
  });

  it('follows available, whole-percent progress and ready, and tells each change once', () => {
    const t = setup();
    t.port.available?.('0.10.0');
    t.port.progress?.(12.4);
    t.port.progress?.(12.9);
    t.port.progress?.(55.5);
    t.port.downloaded?.('0.10.0');
    expect(t.changes.map((state) => state.update)).toEqual([
      { status: 'available', version: '0.10.0' },
      { status: 'downloading', version: '0.10.0', percent: 12 },
      { status: 'downloading', version: '0.10.0', percent: 55 },
      { status: 'ready', version: '0.10.0' },
    ]);
    expect(t.changes.every((state) => state.currentVersion === '0.9.7')).toBe(true);
  });

  it('stops checking once an update is ready', () => {
    const t = setup();
    t.port.downloaded?.('0.10.0');
    expect(t.timers.once.every((timer) => timer.cancelled)).toBe(true);
    expect(t.timers.repeating.every((timer) => timer.cancelled)).toBe(true);
  });

  it('logs a failed check once, keeps it as state and never throws (offline)', async () => {
    const t = setup();
    const offline = new Error('net::ERR_INTERNET_DISCONNECTED');
    t.port.check.mockImplementation(() => {
      t.port.error?.(offline);
      return Promise.reject(offline);
    });
    t.timers.once[0]?.run();
    await vi.waitFor(() => {
      expect(t.controller.state().update).toEqual({
        status: 'error',
        message: 'net::ERR_INTERNET_DISCONNECTED',
      });
    });
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    expect(t.log.error).not.toHaveBeenCalled();
  });

  it('survives a check that throws synchronously', () => {
    const t = setup();
    t.port.check.mockImplementation(() => {
      throw new Error('no app-update.yml');
    });
    expect(() => t.timers.once[0]?.run()).not.toThrow();
    expect(t.controller.state().update).toEqual({ status: 'error', message: 'no app-update.yml' });
  });

  it('keeps a ready update installable after a later error', () => {
    const t = setup();
    t.port.downloaded?.('0.10.0');
    t.port.error?.(new Error('later'));
    expect(t.controller.state().update).toEqual({ status: 'ready', version: '0.10.0' });
  });

  it('refuses to install before a download is ready', async () => {
    const t = setup();
    await expect(t.controller.install()).resolves.toEqual({
      status: 'failed',
      message: 'no update is ready to install',
    });
    expect(t.port.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs a ready update after the exit gates agree, and approves the quit', async () => {
    const t = setup();
    t.port.downloaded?.('0.10.0');
    await expect(t.controller.install()).resolves.toEqual({ status: 'restarting' });
    expect(t.port.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(t.approveQuit).toHaveBeenCalledTimes(1);
  });

  it('does not install while a gate (a recording) refuses', async () => {
    const gates = new ExitGateRegistry();
    gates.register(() => false);
    const t = setup({ gates });
    t.port.downloaded?.('0.10.0');
    await expect(t.controller.install()).resolves.toEqual({ status: 'refused' });
    expect(t.port.quitAndInstall).not.toHaveBeenCalled();
    expect(t.approveQuit).not.toHaveBeenCalled();
  });

  it('reports an installer that would not start as failed', async () => {
    const t = setup();
    t.port.quitAndInstall.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    t.port.downloaded?.('0.10.0');
    await expect(t.controller.install()).resolves.toEqual({
      status: 'failed',
      message: 'spawn failed',
    });
    expect(t.log.error).toHaveBeenCalledTimes(1);
    expect(t.approveQuit).not.toHaveBeenCalled();
  });
});

describe('disabledUpdates', () => {
  it('stays idle and has nothing to install', async () => {
    const updates = disabledUpdates('1.2.3');
    expect(updates.state()).toEqual({ currentVersion: '1.2.3', update: { status: 'idle' } });
    expect((await updates.install()).status).toBe('failed');
  });
});

describe('updatesEnabled', () => {
  it('runs only in an installed release, never in dev, e2e or fake native', () => {
    expect(updatesEnabled(true, {})).toBe(true);
    expect(updatesEnabled(false, {})).toBe(false);
    expect(updatesEnabled(true, { VOZELLA_E2E: '1' })).toBe(false);
    expect(updatesEnabled(true, { VOZELLA_FAKE_NATIVE: '1' })).toBe(false);
  });
});
