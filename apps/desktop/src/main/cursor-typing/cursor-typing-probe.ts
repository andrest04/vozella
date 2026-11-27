import type { ForegroundTarget, TextInjectorPort } from '@vozella/core';
import { FAKE_NOTEPAD_TARGET, FakeTextInjector } from '@vozella/platform';

/** The fake windows a test can put in the foreground. */
export type FakeForeground = 'notepad' | 'none' | 'own-window' | 'blocked' | 'other-window';

/**
 * What the type at cursor e2e reads and drives through `app.evaluate`: the text the fake injector
 * typed and the fake foreground window. Installed only in test mode on the fake native build, so
 * a production build exposes nothing and the real injector is never reachable from a test.
 */
export interface CursorTypingProbe {
  /** Every string typed so far, in order, as the typer sent it (later lines lead with a space). */
  typed(): string[];
  /** Forgets what was typed, so a test starts from nothing. */
  clearTyped(): void;
  /** Puts one of the fake windows in the foreground, or none. */
  setForeground(foreground: FakeForeground): void;
}

export const CURSOR_TYPING_PROBE_KEY = '__vozellaCursorTypingProbe';

const FOREGROUNDS: Readonly<Record<FakeForeground, ForegroundTarget | null>> = {
  notepad: FAKE_NOTEPAD_TARGET,
  none: null,
  'own-window': { ...FAKE_NOTEPAD_TARGET, processName: 'Vozella.exe', isOwnProcess: true },
  blocked: { ...FAKE_NOTEPAD_TARGET, blocked: true },
  'other-window': {
    ...FAKE_NOTEPAD_TARGET,
    windowHandle: 2001,
    focusHandle: 2002,
    processId: 5151,
    processName: 'chrome.exe',
  },
};

/** Installs the probe when the injector is the fake one; the real injector gets none. */
export function installCursorTypingProbe(
  injector: TextInjectorPort,
  target: Record<string, unknown> = globalThis,
): CursorTypingProbe | undefined {
  if (!(injector instanceof FakeTextInjector)) return undefined;
  const probe: CursorTypingProbe = {
    typed: () => [...injector.typed],
    clearTyped: () => {
      injector.typed.length = 0;
    },
    setForeground: (foreground) => {
      if (!Object.hasOwn(FOREGROUNDS, foreground)) {
        throw new Error(`unknown fake foreground: ${foreground}`);
      }
      injector.target = FOREGROUNDS[foreground];
    },
  };
  target[CURSOR_TYPING_PROBE_KEY] = probe;
  return probe;
}
