import {
  extractCommittedBody,
  isTranscriptHeader,
  splitCommittedLines,
} from '../transcription/committed-line';
import type { LineSource } from '../transcription/line-source';
import type { ForegroundTarget, TextInjectorPort } from './text-injector';

/** Which committed lines are typed: only the other participants, or every line. */
export type CursorTypingSource = 'others' | 'all';

/** Why arming was refused: there is nothing safe to type into. */
export type CursorTypingRefusal = 'no-target' | 'own-window' | 'blocked';

/** Why typing is on hold while armed; queued lines wait, except the cut-off one. */
export type CursorTypingPauseReason = 'focus-changed' | 'own-window' | 'blocked' | 'interrupted';

/** No microphone levels, so "only them" cannot tell who spoke and types nothing. */
export type CursorTypingWarning = 'speaker-unknown';

/** Plain data only: it crosses IPC to the renderer as is. */
export type CursorTypingState =
  | { readonly status: 'off' }
  | {
      readonly status: 'armed';
      readonly source: CursorTypingSource;
      readonly processName: string | null;
      readonly warning: CursorTypingWarning | null;
    }
  | {
      readonly status: 'paused';
      readonly source: CursorTypingSource;
      readonly processName: string | null;
      readonly reason: CursorTypingPauseReason;
      readonly warning: CursorTypingWarning | null;
    };

export type CursorTypingArmResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: CursorTypingRefusal };

/** Time is injected so the typer stays deterministic in tests. */
export interface CursorTypingTimers {
  /** Runs `run` on a later tick. */
  schedule(run: () => void): void;
  /** Runs `run` after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export interface CursorTyperDeps {
  readonly injector: TextInjectorPort;
  /** Who spoke a committed line; main binds it to the live microphone share. */
  readonly classify: (line: string) => LineSource;
  readonly timers: CursorTypingTimers;
}

/** Short: the user is most likely still releasing the arm shortcut. */
export const CURSOR_TYPING_MODIFIER_RETRY_MS = 150;

/** Slower: waits for the user to come back to the field or for the window to change. */
export const CURSOR_TYPING_PAUSED_RETRY_MS = 500;

interface Arming {
  readonly source: CursorTypingSource;
  readonly windowHandle: number;
  readonly focusHandle: number | null;
  readonly processName: string | null;
}

/** Collapses every run of whitespace or control characters: a typed Enter would send a message. */
const toSegment = (line: string): string =>
  extractCommittedBody(line)
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim();

const lineCount = (text: string): number => splitCommittedLines(text).length;

const sameState = (a: CursorTypingState, b: CursorTypingState): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Types finalized live lines into the field that had focus when it was armed, one OS call per
 * line. Before every line it probes the foreground again, because typing goes to whatever has
 * focus: a changed window pauses instead of typing into the wrong app. Committed text is append
 * only, so new lines are the ones past the count already seen.
 */
export class CursorTyper {
  private latest = '';
  /** Committed lines already looked at, armed or not. */
  private seen = 0;
  private scheduled = false;
  private arming: Arming | null = null;
  private queue: string[] = [];
  /** Something reached the field this arming, so the next segment needs a separating space. */
  private typedAny = false;
  private warning: CursorTypingWarning | null = null;
  private cancelRetry: (() => void) | null = null;
  private current: CursorTypingState = { status: 'off' };
  private readonly listeners = new Set<(state: CursorTypingState) => void>();

  constructor(private readonly deps: CursorTyperDeps) {}

  /** Called on every live update with the full committed text, armed or not. */
  committed(text: string): void {
    this.latest = text;
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.timers.schedule(() => {
      this.scheduled = false;
      this.process();
    });
  }

  /**
   * Arms on the window in the foreground now. A refusal leaves the current state untouched;
   * arming again moves to the new target and drops lines queued for the old one.
   */
  arm(source: CursorTypingSource): CursorTypingArmResult {
    const target = this.deps.injector.foregroundTarget();
    if (target === null) return { ok: false, reason: 'no-target' };
    if (target.isOwnProcess) return { ok: false, reason: 'own-window' };
    if (target.blocked) return { ok: false, reason: 'blocked' };
    this.clearWork();
    this.arming = {
      source,
      windowHandle: target.windowHandle,
      focusHandle: target.focusHandle,
      processName: target.processName,
    };
    // Lines already said, even in an update not processed yet, belong to before the arming.
    this.seen = lineCount(this.latest);
    this.typedAny = false;
    this.warning = null;
    this.emit({ status: 'armed', source, processName: target.processName, warning: null });
    return { ok: true };
  }

  disarm(): void {
    this.clearWork();
    this.arming = null;
    this.emit({ status: 'off' });
  }

  /** A new take, Stop or Discard: off, and the take's lines are forgotten. */
  reset(): void {
    this.disarm();
    this.latest = '';
    this.seen = 0;
  }

  state(): CursorTypingState {
    return this.current;
  }

  /** Returns the unsubscribe function. */
  onState(listener: (state: CursorTypingState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private process(): void {
    const lines = splitCommittedLines(this.latest);
    // A shorter text is a new take that came without a reset: count from its start.
    const from = Math.min(this.seen, lines.length);
    this.seen = lines.length;
    if (this.arming === null) return;
    for (const line of lines.slice(from)) this.enqueue(line, this.arming.source);
    this.drain();
  }

  private enqueue(line: string, source: CursorTypingSource): void {
    if (line.trim() === '' || isTranscriptHeader(line)) return;
    const segment = toSegment(line);
    if (segment === '') return;
    if (source === 'others') {
      const speaker = this.deps.classify(line);
      this.setWarning(speaker === 'unknown' ? 'speaker-unknown' : null);
      if (speaker !== 'others') return;
    }
    this.queue.push(segment);
  }

  /** Types queued lines in order until one needs to wait; a pending retry owns the next attempt. */
  private drain(): void {
    while (this.arming !== null && this.cancelRetry === null && this.queue.length > 0) {
      const target = this.deps.injector.foregroundTarget();
      const hold = this.holdReason(this.arming, target);
      if (hold !== null) {
        this.pause(hold);
        this.retryAfter(CURSOR_TYPING_PAUSED_RETRY_MS);
        return;
      }
      if (target?.modifiersHeld === true || target?.menuOpen === true) {
        this.retryAfter(CURSOR_TYPING_MODIFIER_RETRY_MS);
        return;
      }
      const segment = this.queue.shift() ?? '';
      if (!this.type(this.typedAny ? ` ${segment}` : segment)) {
        this.pause('interrupted');
        this.retryAfter(CURSOR_TYPING_PAUSED_RETRY_MS);
        return;
      }
      this.resume();
    }
  }

  private holdReason(
    arming: Arming,
    target: ForegroundTarget | null,
  ): Exclude<CursorTypingPauseReason, 'interrupted'> | null {
    if (target === null) return 'focus-changed';
    if (target.isOwnProcess) return 'own-window';
    if (target.windowHandle !== arming.windowHandle) return 'focus-changed';
    if (
      arming.focusHandle !== null &&
      target.focusHandle !== null &&
      target.focusHandle !== arming.focusHandle
    ) {
      return 'focus-changed';
    }
    if (target.blocked) return 'blocked';
    return null;
  }

  /** False when the line was cut off or failed; it is dropped, never retyped. */
  private type(text: string): boolean {
    try {
      const result = this.deps.injector.typeText(text);
      if (result.sent > 0) this.typedAny = true;
      return result.sent >= result.expected;
    } catch {
      return false;
    }
  }

  private retryAfter(ms: number): void {
    this.cancelRetry = this.deps.timers.after(ms, () => {
      this.cancelRetry = null;
      this.drain();
    });
  }

  private clearWork(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.queue = [];
  }

  private pause(reason: CursorTypingPauseReason): void {
    if (this.arming === null) return;
    const { source, processName } = this.arming;
    this.emit({ status: 'paused', source, processName, reason, warning: this.warning });
  }

  private resume(): void {
    if (this.arming === null) return;
    const { source, processName } = this.arming;
    this.emit({ status: 'armed', source, processName, warning: this.warning });
  }

  private setWarning(warning: CursorTypingWarning | null): void {
    this.warning = warning;
    if (this.current.status === 'off') return;
    this.emit({ ...this.current, warning });
  }

  private emit(next: CursorTypingState): void {
    if (sameState(this.current, next)) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
