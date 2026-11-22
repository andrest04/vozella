import type { Logger } from '../logging';
import type { MeetingWindowMatch } from './call-detector';
import { shouldShowPopup } from './popup-policy';

/** Poll period of the call watcher. */
export const CALL_POLL_INTERVAL_MS = 5000;

/** Port: repeating timer. Adapter lives in main; tests use a fake. */
export interface Scheduler {
  /** Runs `callback` every `intervalMs` until the returned function is called. */
  setInterval(callback: () => void, intervalMs: number): () => void;
}

/** Port: the first meeting call window open right now, or null when there is none. */
export interface WindowScanPort {
  findMeetingWindow(): Promise<MeetingWindowMatch | null>;
}

/** The slice of Workspace the watcher needs. */
export interface CallWatcherWorkspace {
  readonly state: { readonly isCaptureActive: boolean };
  offerCallPrompt(): void;
}

export interface CallWatcherSettings {
  readMeetingPopupEnabled(): Promise<boolean>;
}

export interface CallWatcherPorts {
  scanner: WindowScanPort;
  workspace: CallWatcherWorkspace;
  settings: CallWatcherSettings;
  scheduler: Scheduler;
  logger: Logger;
}

/** What each event hands its handlers: a detection names the call's app. */
export interface CallWatcherHandlers {
  meetingDetected: (match: MeetingWindowMatch) => void;
  meetingEnded: () => void;
}

export type CallWatcherEvent = keyof CallWatcherHandlers;

/**
 * Detects a meeting call and emits at most one `meetingDetected` per call.
 * Re-armed only after no call window is seen, which emits `meetingEnded`.
 */
export class CallWatcher {
  private armed = true;
  private windowFound = false;
  private ticking = false;
  private stopTimer: (() => void) | null = null;
  private readonly detectedHandlers = new Set<CallWatcherHandlers['meetingDetected']>();
  private readonly endedHandlers = new Set<CallWatcherHandlers['meetingEnded']>();

  constructor(private readonly ports: CallWatcherPorts) {}

  on<E extends CallWatcherEvent>(event: E, handler: CallWatcherHandlers[E]): () => void {
    const handlers = (
      event === 'meetingDetected' ? this.detectedHandlers : this.endedHandlers
    ) as Set<CallWatcherHandlers[E]>;
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  start(): void {
    if (this.stopTimer) return;
    this.stopTimer = this.ports.scheduler.setInterval(() => {
      void this.tick();
    }, CALL_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** One poll. Never throws; an overlapping call is dropped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let disarmedThisTick = false;
    try {
      const match = await this.ports.scanner.findMeetingWindow();
      const inCall = match !== null;
      if (inCall !== this.windowFound) {
        this.windowFound = inCall;
        // The app only: a window title can carry a meeting name.
        if (match) this.ports.logger.info('Call window found', { app: match.app });
        else this.ports.logger.info('Call window gone');
      }
      if (!match) {
        if (!this.armed) {
          this.armed = true;
          for (const handler of [...this.endedHandlers]) handler();
        }
        return;
      }
      if (!this.armed) return;
      if (this.ports.workspace.state.isCaptureActive) {
        this.armed = false;
        return;
      }
      this.armed = false;
      disarmedThisTick = true;
      this.ports.workspace.offerCallPrompt();
      const enabled = await this.readPopupEnabled();
      if (shouldShowPopup(enabled, this.ports.workspace.state.isCaptureActive, false)) {
        for (const handler of [...this.detectedHandlers]) handler(match);
      } else {
        this.ports.logger.info('Call detected, popup not shown', { enabled });
      }
      disarmedThisTick = false;
    } catch (error) {
      if (disarmedThisTick) this.armed = true;
      this.safeLog('Call watcher tick failed', error);
    } finally {
      this.ticking = false;
    }
  }

  private async readPopupEnabled(): Promise<boolean> {
    try {
      return await this.ports.settings.readMeetingPopupEnabled();
    } catch (error) {
      this.safeLog('Reading the popup setting failed, defaulting to on', error);
      return true;
    }
  }

  private safeLog(message: string, error: unknown): void {
    try {
      // The type only. A message can carry a window title or a path.
      this.ports.logger.warn(message, {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } catch {
      // logging must not break the watcher
    }
  }
}
