import type { CursorTypingStatusDto } from '@vozella/contracts';
import { InMemorySettingsStore, type CursorTypingTimers, type Logger } from '@vozella/core';
import { FAKE_NOTEPAD_TARGET, FakeTextInjector } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { CursorTypingController, type ShortcutRegistry } from './cursor-typing-controller';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Records registrations; `refuse` makes Windows say the combination is taken. */
class FakeShortcuts implements ShortcutRegistry {
  readonly held = new Map<string, () => void>();
  readonly calls: string[] = [];
  refuse = false;
  throws = false;

  register(accelerator: string, callback: () => void): boolean {
    this.calls.push(`register ${accelerator}`);
    if (this.throws) throw new Error('conversion failure');
    if (this.refuse) return false;
    this.held.set(accelerator, callback);
    return true;
  }

  unregister(accelerator: string): void {
    this.calls.push(`unregister ${accelerator}`);
    this.held.delete(accelerator);
  }

  press(accelerator: string): void {
    const callback = this.held.get(accelerator);
    if (!callback) throw new Error(`${accelerator} is not registered`);
    callback();
  }
}

/** Ticks run at once; delayed retries wait until `fire`. */
class ManualTimers implements CursorTypingTimers {
  private readonly pending = new Set<() => void>();
  schedule(run: () => void): void {
    run();
  }
  after(_ms: number, run: () => void): () => void {
    this.pending.add(run);
    return () => this.pending.delete(run);
  }
}

const DEFAULT = 'CommandOrControl+Alt+Space';
const line = (startS: number, text: string): string =>
  `[00:${String(startS).padStart(2, '0')}.00-00:${String(startS + 1).padStart(2, '0')}.00] ${text}`;

async function setup(options: { share?: number | null; settings?: Record<string, unknown> } = {}) {
  const settings = new InMemorySettingsStore();
  if (options.settings) await settings.update(options.settings);
  const injector = new FakeTextInjector();
  const shortcuts = new FakeShortcuts();
  const statuses: CursorTypingStatusDto[] = [];
  const liveListeners = new Set<(displayText: string, committedText: string) => void>();
  const log = logger();
  const share = vi.fn((_startMs: number, _endMs: number) =>
    options.share === undefined ? 0 : options.share,
  );
  const controller = new CursorTypingController({
    injector,
    micDominantShare: share,
    onLiveUpdate: (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    settings,
    shortcuts,
    broadcast: (channel, payload) => {
      expect(channel.name).toBe('cursorTyping.state');
      statuses.push(payload as CursorTypingStatusDto);
    },
    logger: log,
    timers: new ManualTimers(),
  });
  await controller.refreshSettings();
  const committed = (text: string): void => {
    for (const listener of [...liveListeners]) listener(text, text);
  };
  return {
    controller,
    settings,
    injector,
    shortcuts,
    statuses,
    liveListeners,
    log,
    share,
    committed,
    last: () => statuses.at(-1),
  };
}

describe('CursorTypingController shortcut', () => {
  it('holds the shortcut only while a take records', async () => {
    const t = await setup();
    expect(t.shortcuts.held.size).toBe(0);
    expect(t.controller.status().shortcut).toEqual({ status: 'inactive', accelerator: DEFAULT });

    t.controller.setRecording(true);
    expect([...t.shortcuts.held.keys()]).toEqual([DEFAULT]);
    expect(t.last()?.shortcut).toEqual({ status: 'registered', accelerator: DEFAULT });

    t.controller.setRecording(false);
    expect(t.shortcuts.held.size).toBe(0);
    expect(t.last()?.shortcut.status).toBe('inactive');
  });

  it('never registers while the feature is off, and lets go when it is turned off', async () => {
    const t = await setup({ settings: { cursorTypingEnabled: false } });
    t.controller.setRecording(true);
    expect(t.shortcuts.calls).toEqual([]);

    await t.settings.update({ cursorTypingEnabled: true });
    await t.controller.refreshSettings();
    expect([...t.shortcuts.held.keys()]).toEqual([DEFAULT]);
    t.shortcuts.press(DEFAULT);
    expect(t.controller.status().state.status).toBe('armed');

    await t.settings.update({ cursorTypingEnabled: false });
    await t.controller.refreshSettings();
    expect(t.shortcuts.held.size).toBe(0);
    expect(t.last()).toMatchObject({ state: { status: 'off' }, shortcut: { status: 'inactive' } });
  });

  it('moves to a changed shortcut while recording', async () => {
    const t = await setup();
    t.controller.setRecording(true);
    await t.settings.update({ cursorTypingShortcut: 'Alt+F9' });
    await t.controller.refreshSettings();
    expect(t.shortcuts.calls).toEqual([
      `register ${DEFAULT}`,
      `unregister ${DEFAULT}`,
      'register Alt+F9',
    ]);
    expect([...t.shortcuts.held.keys()]).toEqual(['Alt+F9']);
    expect(t.last()?.shortcut).toEqual({ status: 'registered', accelerator: 'Alt+F9' });
  });

  it('reports the shortcut unavailable when Windows refuses it or it is not valid', async () => {
    const refused = await setup();
    refused.shortcuts.refuse = true;
    refused.controller.setRecording(true);
    expect(refused.last()?.shortcut).toEqual({ status: 'unavailable', accelerator: DEFAULT });
    expect(refused.log.warn).toHaveBeenCalled();

    const invalid = await setup({ settings: { cursorTypingShortcut: 'Nope+' } });
    invalid.shortcuts.throws = true;
    invalid.controller.setRecording(true);
    expect(invalid.last()?.shortcut).toEqual({ status: 'unavailable', accelerator: 'Nope+' });

    invalid.controller.setRecording(false);
    expect(invalid.last()?.shortcut.status).toBe('inactive');
    expect(invalid.shortcuts.calls.filter((call) => call.startsWith('unregister'))).toEqual([]);
  });

  it('lets go of the shortcut and the live updates on dispose', async () => {
    const t = await setup();
    t.controller.setRecording(true);
    t.controller.dispose();
    expect(t.shortcuts.held.size).toBe(0);
    expect(t.liveListeners.size).toBe(0);
    t.controller.setRecording(true);
    expect(t.shortcuts.held.size).toBe(0);
  });
});

describe('CursorTypingController toggle', () => {
  it('a press arms on the foreground window with the saved source, the next disarms', async () => {
    const t = await setup({ settings: { cursorTypingSource: 'all' } });
    t.controller.setRecording(true);
    t.shortcuts.press(DEFAULT);
    expect(t.last()).toEqual({
      state: { status: 'armed', source: 'all', processName: 'notepad.exe', warning: null },
      shortcut: { status: 'registered', accelerator: DEFAULT },
      lastRefusal: null,
    });
    t.shortcuts.press(DEFAULT);
    expect(t.last()?.state).toEqual({ status: 'off' });
  });

  it('types the others lines that come after the arming and skips the local user', async () => {
    const t = await setup({ share: 0 });
    t.controller.setRecording(true);
    t.committed(line(0, 'said before'));
    expect(t.controller.toggle()).toEqual({ ok: true });
    t.committed([line(0, 'said before'), line(2, 'how much is it')].join('\n'));
    expect(t.injector.typed).toEqual(['how much is it']);

    t.share.mockReturnValue(0.9);
    t.committed(
      [line(0, 'said before'), line(2, 'how much is it'), line(4, 'my words')].join('\n'),
    );
    expect(t.injector.typed).toEqual(['how much is it']);
  });

  it('a source change while armed applies on the next arm', async () => {
    const t = await setup();
    t.controller.setRecording(true);
    t.controller.toggle();
    await t.settings.update({ cursorTypingSource: 'all' });
    await t.controller.refreshSettings();
    expect(t.controller.status().state).toMatchObject({ status: 'armed', source: 'others' });
    t.controller.toggle();
    t.controller.toggle();
    expect(t.controller.status().state).toMatchObject({ status: 'armed', source: 'all' });
  });

  it('refuses as inactive while nothing records, and keeps the refusal until the next arm', async () => {
    const t = await setup();
    expect(t.controller.toggle()).toEqual({ ok: false, reason: 'inactive' });
    expect(t.last()).toMatchObject({ state: { status: 'off' }, lastRefusal: 'inactive' });

    t.controller.setRecording(true);
    expect(t.last()?.lastRefusal).toBeNull();
    t.injector.target = { ...FAKE_NOTEPAD_TARGET, isOwnProcess: true };
    expect(t.controller.toggle()).toEqual({ ok: false, reason: 'own-window' });
    expect(t.last()).toMatchObject({ state: { status: 'off' }, lastRefusal: 'own-window' });

    t.injector.target = FAKE_NOTEPAD_TARGET;
    expect(t.controller.toggle()).toEqual({ ok: true });
    expect(t.last()?.lastRefusal).toBeNull();
  });

  it('a toggle that disarms answers null', async () => {
    const t = await setup();
    t.controller.setRecording(true);
    t.controller.toggle();
    expect(t.controller.toggle()).toBeNull();
    expect(t.controller.status().state).toEqual({ status: 'off' });
  });
});

describe('CursorTypingController recording lifecycle', () => {
  it('the end of a take disarms, and its lines are never typed into the next one', async () => {
    const t = await setup();
    t.controller.setRecording(true);
    t.controller.toggle();
    const before = t.statuses.length;
    t.controller.setRecording(false);
    // One status for the whole step: typer off and shortcut released together.
    expect(t.statuses.slice(before)).toEqual([
      {
        state: { status: 'off' },
        shortcut: { status: 'inactive', accelerator: DEFAULT },
        lastRefusal: null,
      },
    ]);

    // Lines that arrive while Stop drains are not typed.
    t.committed(line(0, 'drained after stop'));
    expect(t.injector.typed).toEqual([]);

    t.controller.setRecording(true);
    t.controller.toggle();
    t.committed(line(0, 'first of the new take'));
    expect(t.injector.typed).toEqual(['first of the new take']);
  });

  it('broadcasts every change once, never a repeat of the same status', async () => {
    const t = await setup();
    expect(t.statuses).toEqual([
      {
        state: { status: 'off' },
        shortcut: { status: 'inactive', accelerator: DEFAULT },
        lastRefusal: null,
      },
    ]);
    t.controller.setRecording(true);
    t.controller.setRecording(true);
    await t.controller.refreshSettings();
    expect(t.statuses).toHaveLength(2);
    t.controller.toggle();
    expect(t.statuses).toHaveLength(3);
  });
});
