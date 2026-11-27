/**
 * The window that would receive typed keys right now. Typing goes to whatever has focus, so the
 * caller compares this against the target it armed before every line.
 */
export interface ForegroundTarget {
  readonly windowHandle: number;
  /** The focused control inside the foreground window's thread; null when none is reported. */
  readonly focusHandle: number | null;
  readonly processId: number;
  /** Executable file name, such as `notepad.exe`; null when the process cannot be queried. */
  readonly processName: string | null;
  /** The foreground window belongs to this app, which must never type into itself. */
  readonly isOwnProcess: boolean;
  /** A menu is open: typed keys would pick menu items instead of reaching the field. */
  readonly menuOpen: boolean;
  /** Shift, Ctrl, Alt or Win is held: typed keys would turn into shortcuts. */
  readonly modifiersHeld: boolean;
  /**
   * The target runs at a higher integrity level (an admin window) or could not be checked.
   * Windows drops the keys silently in that case (UIPI) and still reports them as sent.
   */
  readonly blocked: boolean;
}

/** Key events delivered versus the number needed; fewer means the line was cut off. */
export interface TypeTextResult {
  readonly sent: number;
  readonly expected: number;
}

/** Types text into the focused field of another app. Never uses the clipboard. */
export interface TextInjectorPort {
  /** Null when no window is in the foreground. */
  foregroundTarget(): ForegroundTarget | null;
  /**
   * Types one line in a single OS call, so the user's own keystrokes cannot interleave with it.
   * Control characters are typed as spaces: a line never presses Enter or Tab.
   */
  typeText(text: string): TypeTextResult;
}
