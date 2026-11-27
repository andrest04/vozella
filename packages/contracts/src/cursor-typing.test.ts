import { describe, expect, it } from 'vitest';
import {
  cursorTypingGetState,
  cursorTypingStateChanged,
  cursorTypingStatusSchema,
  cursorTypingToggle,
  eventChannels,
  requestChannels,
} from './index';

const armed = {
  status: 'armed',
  source: 'others',
  processName: 'chrome.exe',
  warning: null,
} as const;

describe('cursor typing contracts', () => {
  it('registers the toggle and state requests and the state event by name', () => {
    expect(Object.keys(requestChannels)).toEqual(
      expect.arrayContaining(['cursorTyping.toggle', 'cursorTyping.getState']),
    );
    expect(Object.keys(eventChannels)).toContain('cursorTyping.state');
    expect(cursorTypingStateChanged.name).toBe('cursorTyping.state');
  });

  it('carries every typer state, the shortcut status and the last refusal', () => {
    const states = [
      { status: 'off' },
      armed,
      {
        status: 'paused',
        source: 'all',
        processName: null,
        reason: 'focus-changed',
        warning: 'speaker-unknown',
      },
    ];
    for (const state of states) {
      const status = {
        state,
        shortcut: { status: 'registered', accelerator: 'CommandOrControl+Alt+Space' },
        lastRefusal: null,
      };
      expect(cursorTypingStatusSchema.parse(status)).toEqual(status);
    }
    expect(
      cursorTypingStatusSchema.safeParse({
        state: { status: 'off' },
        shortcut: { status: 'unavailable', accelerator: 'Nope+' },
        lastRefusal: 'own-window',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown typer status, pause reason, shortcut status or refusal', () => {
    const base = {
      state: { status: 'off' },
      shortcut: { status: 'inactive', accelerator: 'Alt+F9' },
      lastRefusal: null,
    };
    expect(cursorTypingStatusSchema.safeParse(base).success).toBe(true);
    expect(
      cursorTypingStatusSchema.safeParse({ ...base, state: { status: 'typing' } }).success,
    ).toBe(false);
    expect(
      cursorTypingStatusSchema.safeParse({
        ...base,
        state: { ...armed, status: 'paused', reason: 'lunch' },
      }).success,
    ).toBe(false);
    expect(
      cursorTypingStatusSchema.safeParse({
        ...base,
        shortcut: { status: 'stolen', accelerator: 'Alt+F9' },
      }).success,
    ).toBe(false);
    expect(cursorTypingStatusSchema.safeParse({ ...base, lastRefusal: 'busy' }).success).toBe(
      false,
    );
  });

  it('counts refused presses, so the same refusal twice is still news', () => {
    const base = {
      state: { status: 'off' },
      shortcut: { status: 'inactive', accelerator: 'Alt+F9' },
      lastRefusal: 'inactive',
    };
    expect(cursorTypingStatusSchema.parse({ ...base, refusalSeq: 2 })).toEqual({
      ...base,
      refusalSeq: 2,
    });
    expect(cursorTypingStatusSchema.safeParse({ ...base, refusalSeq: -1 }).success).toBe(false);
    expect(cursorTypingStatusSchema.safeParse({ ...base, refusalSeq: 1.5 }).success).toBe(false);
  });

  it('toggle takes no input and answers the arm outcome with the new status', () => {
    expect(cursorTypingToggle.input.safeParse({}).success).toBe(true);
    expect(cursorTypingToggle.input.safeParse({ source: 'all' }).success).toBe(false);
    expect(cursorTypingGetState.input.safeParse({ now: true }).success).toBe(false);
    const status = {
      state: armed,
      shortcut: { status: 'registered', accelerator: 'Alt+F9' },
      lastRefusal: null,
    };
    expect(cursorTypingToggle.output.parse({ arm: { ok: true }, status })).toEqual({
      arm: { ok: true },
      status,
    });
    expect(
      cursorTypingToggle.output.safeParse({
        arm: { ok: false, reason: 'inactive' },
        status: { ...status, state: { status: 'off' }, lastRefusal: 'inactive' },
      }).success,
    ).toBe(true);
    // Disarming arms nothing.
    expect(cursorTypingToggle.output.safeParse({ arm: null, status }).success).toBe(true);
    expect(
      cursorTypingToggle.output.safeParse({ arm: { ok: false, reason: 'nope' }, status }).success,
    ).toBe(false);
  });
});
