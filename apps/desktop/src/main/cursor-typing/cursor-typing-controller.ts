import {
  cursorTypingStateChanged,
  type CursorTypingRefusalDto,
  type CursorTypingStatusDto,
  type EventChannel,
  type PayloadInputOf,
} from '@vozella/contracts';
import {
  classifyCommittedLine,
  CursorTyper,
  DEFAULT_CURSOR_TYPING_SHORTCUT,
  resolveCursorTypingShortcut,
  resolveCursorTypingSource,
  type CursorTypingSource,
  type CursorTypingTimers,
  type Logger,
  type SettingsStore,
  type TextInjectorPort,
} from '@vozella/core';

type Broadcast = <C extends EventChannel>(channel: C, payload: PayloadInputOf<C>) => void;

/** The slice of Electron's `globalShortcut` the controller uses. */
export interface ShortcutRegistry {
  /** False when another app owns the combination; throws when the accelerator is not valid. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export type CursorTypingToggleResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: CursorTypingRefusalDto };

export interface CursorTypingControllerDeps {
  readonly injector: TextInjectorPort;
  /** The live session's microphone share of a span; null when no levels are known. */
  readonly micDominantShare: (startMs: number, endMs: number) => number | null;
  /** Every live transcript update; returns the unsubscribe function. */
  readonly onLiveUpdate: (
    listener: (displayText: string, committedText: string) => void,
  ) => () => void;
  readonly settings: Pick<SettingsStore, 'load'>;
  readonly shortcuts: ShortcutRegistry;
  readonly broadcast: Broadcast;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** Defaults to `setImmediate` and `setTimeout`. */
  readonly timers?: CursorTypingTimers;
}

export const systemCursorTypingTimers: CursorTypingTimers = {
  schedule: (run) => {
    setImmediate(run);
  },
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

interface Preferences {
  readonly enabled: boolean;
  readonly accelerator: string;
  readonly source: CursorTypingSource;
}

type ShortcutStatus = CursorTypingStatusDto['shortcut']['status'];

/**
 * Type at cursor in the main process: one core typer fed by the live transcript, and the global
 * shortcut that toggles it. The shortcut is held only while a take records and the feature is on,
 * so the combination stays free for other apps the rest of the time.
 */
export class CursorTypingController {
  private readonly typer: CursorTyper;
  /** Off until the settings are read, so nothing is registered before they are known. */
  private prefs: Preferences = {
    enabled: false,
    accelerator: DEFAULT_CURSOR_TYPING_SHORTCUT,
    source: 'others',
  };
  private recording = false;
  /** The accelerator registered with the OS right now, if any. */
  private held: string | null = null;
  private shortcutStatus: ShortcutStatus = 'inactive';
  private lastRefusal: CursorTypingRefusalDto | null = null;
  /** Bumped by every refused toggle and never reset: an identical refusal is still broadcast. */
  private refusalSeq = 0;
  private published: string | null = null;
  /** Above zero while a step runs: the typer's own emits wait for the step's single publish. */
  private quiet = 0;
  private disposed = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: CursorTypingControllerDeps) {
    this.typer = new CursorTyper({
      injector: deps.injector,
      classify: (line) => classifyCommittedLine(line, deps.micDominantShare),
      timers: deps.timers ?? systemCursorTypingTimers,
    });
    this.offs.push(
      this.typer.onState(() => {
        this.publish();
      }),
      deps.onLiveUpdate((_displayText, committedText) => {
        this.typer.committed(committedText);
      }),
    );
  }

  /** Reads the settings again: at startup and after a save. A new source applies on the next arm. */
  async refreshSettings(): Promise<void> {
    const settings = await this.deps.settings.load();
    if (this.disposed) return;
    this.batch(() => {
      this.prefs = {
        enabled: settings.cursorTypingEnabled,
        accelerator: resolveCursorTypingShortcut(settings),
        source: resolveCursorTypingSource(settings),
      };
      if (!this.prefs.enabled) this.typer.disarm();
      this.syncShortcut();
    });
  }

  /**
   * Whether a take records. Both edges reset the typer: a new take starts off and forgets the last
   * take's lines, and Stop or Discard disarms before the last lines drain.
   */
  setRecording(active: boolean): void {
    if (this.disposed || active === this.recording) return;
    this.batch(() => {
      this.recording = active;
      this.lastRefusal = null;
      this.typer.reset();
      this.syncShortcut();
    });
  }

  /**
   * The shortcut and the `cursorTyping.toggle` command: arms on the foreground window when off,
   * disarms otherwise (null). From a Vozella window the arm is refused with `own-window`, since
   * Vozella is then the foreground app; the command exists for the pill, the fake native build
   * and tests.
   */
  toggle(): CursorTypingToggleResult | null {
    return this.batch(() => {
      this.lastRefusal = null;
      if (this.typer.state().status !== 'off') {
        this.typer.disarm();
        return null;
      }
      const result: CursorTypingToggleResult = this.isActive()
        ? this.typer.arm(this.prefs.source)
        : { ok: false, reason: 'inactive' };
      if (!result.ok) {
        this.lastRefusal = result.reason;
        this.refusalSeq += 1;
      }
      return result;
    });
  }

  status(): CursorTypingStatusDto {
    return {
      state: this.typer.state(),
      shortcut: { status: this.shortcutStatus, accelerator: this.prefs.accelerator },
      lastRefusal: this.lastRefusal,
      refusalSeq: this.refusalSeq,
    };
  }

  /** On quit: the combination goes back to the OS and nothing types any more. */
  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.typer.reset();
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private isActive(): boolean {
    return this.recording && this.prefs.enabled && !this.disposed;
  }

  /** Holds the wanted accelerator, or none; a changed one is let go before the new one is taken. */
  private syncShortcut(): void {
    const wanted = this.isActive() ? this.prefs.accelerator : null;
    if (wanted !== null && wanted === this.held) return;
    this.release();
    if (wanted === null) {
      this.shortcutStatus = 'inactive';
      return;
    }
    let registered = false;
    try {
      registered = this.deps.shortcuts.register(wanted, () => {
        this.onShortcut();
      });
    } catch (error) {
      this.deps.logger.warn('type at cursor shortcut is not valid', {
        accelerator: wanted,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (registered) {
      this.held = wanted;
      this.shortcutStatus = 'registered';
      return;
    }
    this.shortcutStatus = 'unavailable';
    this.deps.logger.warn('type at cursor shortcut could not be registered', {
      accelerator: wanted,
    });
  }

  private release(): void {
    if (this.held === null) return;
    const accelerator = this.held;
    this.held = null;
    try {
      this.deps.shortcuts.unregister(accelerator);
    } catch (error) {
      this.deps.logger.warn('type at cursor shortcut could not be released', {
        accelerator,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onShortcut(): void {
    const result = this.toggle();
    if (result !== null && !result.ok) {
      this.deps.logger.info('type at cursor arm refused', { reason: result.reason });
    }
  }

  /** Runs `run` with typer emits held back, then publishes the outcome once. */
  private batch<T>(run: () => T): T {
    this.quiet += 1;
    let result: T;
    try {
      result = run();
    } finally {
      this.quiet -= 1;
    }
    this.publish();
    return result;
  }

  /** Broadcasts the status when it differs from the last one sent. */
  private publish(): void {
    if (this.disposed || this.quiet > 0) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.published) return;
    this.published = key;
    this.deps.broadcast(cursorTypingStateChanged, status);
  }
}
