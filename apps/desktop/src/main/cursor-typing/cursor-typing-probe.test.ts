import type { TextInjectorPort } from '@vozella/core';
import { FAKE_NOTEPAD_TARGET, FakeTextInjector } from '@vozella/platform';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_TYPING_PROBE_KEY,
  installCursorTypingProbe,
  type FakeForeground,
} from './cursor-typing-probe';

describe('installCursorTypingProbe', () => {
  it('exposes what the fake injector typed, as a copy, and can forget it', () => {
    const injector = new FakeTextInjector();
    const host: Record<string, unknown> = {};
    const probe = installCursorTypingProbe(injector, host);
    expect(host[CURSOR_TYPING_PROBE_KEY]).toBe(probe);

    injector.typeText('first');
    injector.typeText(' second');
    const typed = probe?.typed();
    expect(typed).toEqual(['first', ' second']);
    typed?.push('not typed');
    expect(injector.typed).toEqual(['first', ' second']);

    probe?.clearTyped();
    expect(probe?.typed()).toEqual([]);
    expect(injector.typed).toEqual([]);
  });

  it('puts each fake window in the foreground', () => {
    const injector = new FakeTextInjector();
    const probe = installCursorTypingProbe(injector, {});

    probe?.setForeground('none');
    expect(injector.foregroundTarget()).toBeNull();
    probe?.setForeground('own-window');
    expect(injector.foregroundTarget()).toMatchObject({ isOwnProcess: true });
    probe?.setForeground('blocked');
    expect(injector.foregroundTarget()).toMatchObject({ blocked: true, isOwnProcess: false });
    probe?.setForeground('other-window');
    const other = injector.foregroundTarget();
    expect(other?.windowHandle).not.toBe(FAKE_NOTEPAD_TARGET.windowHandle);
    expect(other).toMatchObject({ isOwnProcess: false, blocked: false });
    probe?.setForeground('notepad');
    expect(injector.foregroundTarget()).toEqual(FAKE_NOTEPAD_TARGET);
  });

  it('refuses a foreground it does not know', () => {
    const probe = installCursorTypingProbe(new FakeTextInjector(), {});
    expect(() => {
      probe?.setForeground('toString' as FakeForeground);
    }).toThrow(/unknown fake foreground/);
  });

  it('installs nothing over a real injector', () => {
    const real: TextInjectorPort = {
      foregroundTarget: () => null,
      typeText: () => ({ sent: 0, expected: 0 }),
    };
    const host: Record<string, unknown> = {};
    expect(installCursorTypingProbe(real, host)).toBeUndefined();
    expect(host).toEqual({});
  });
});
