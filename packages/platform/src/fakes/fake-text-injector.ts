import type { ForegroundTarget, TextInjectorPort, TypeTextResult } from '@vozella/core';

/** A foreign, unblocked Notepad with a focused edit control. */
export const FAKE_NOTEPAD_TARGET: ForegroundTarget = {
  windowHandle: 1001,
  focusHandle: 1002,
  processId: 4242,
  processName: 'notepad.exe',
  isOwnProcess: false,
  menuOpen: false,
  modifiersHeld: false,
  blocked: false,
};

/**
 * Fake: records every typed string and types nothing. The result counts two key events per
 * UTF-16 unit, as the real injector does; set `respond` to simulate a short count.
 */
export class FakeTextInjector implements TextInjectorPort {
  readonly typed: string[] = [];

  /** The current foreground window; null means no window is in the foreground. */
  target: ForegroundTarget | null = FAKE_NOTEPAD_TARGET;

  /** Overrides the result of each non-empty `typeText` call. */
  respond: ((text: string) => TypeTextResult) | null = null;

  foregroundTarget(): ForegroundTarget | null {
    return this.target;
  }

  typeText(text: string): TypeTextResult {
    // The real injector makes no OS call for an empty string, so there is nothing to record.
    if (text === '') return { sent: 0, expected: 0 };
    this.typed.push(text);
    if (this.respond) return this.respond(text);
    const expected = text.length * 2;
    return { sent: expected, expected };
  }
}
