import type { UpdateInstallOutcome, UpdateState, UpdateStatus } from '@vozella/contracts';
import { RestartService, type ExitGateRegistry, type Logger } from '@vozella/core';

/** The slice of electron-updater this feature uses. The adapter lives in electron-updater-port.ts. */
export interface UpdaterPort {
  onAvailable(listener: (version: string) => void): void;
  onNotAvailable(listener: () => void): void;
  onProgress(listener: (percent: number) => void): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (error: unknown) => void): void;
  /** Checks the feed; a found update downloads by itself. */
  check(): Promise<unknown>;
  /** Quits and runs the downloaded installer silently, which starts the app again. */
  quitAndInstall(): void;
}

/** Timers, injected so tests drive time. Each returns its own cancel. */
export interface UpdateTimers {
  after(ms: number, run: () => void): () => void;
  every(ms: number, run: () => void): () => void;
}

/** What the IPC handlers need, whether updates run or not. */
export interface UpdatesService {
  state(): UpdateState;
  install(): Promise<UpdateInstallOutcome>;
}

export interface UpdateControllerDeps {
  readonly port: UpdaterPort;
  readonly currentVersion: string;
  readonly logger: Logger;
  readonly timers: UpdateTimers;
  /** The exit gates: a recording in progress refuses the install. */
  readonly gates: ExitGateRegistry;
  /** Approves the coming quit so the exit flow does not ask the gates a second time. */
  readonly approveQuit: () => void;
  readonly onChange: (state: UpdateState) => void;
  readonly firstCheckDelayMs?: number;
  readonly checkIntervalMs?: number;
}

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const NOT_READY = 'no update is ready to install';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks shortly after startup and then every few hours, follows the download, and installs on
 * request. Failures (offline included) are logged and kept as state; they never reach a dialog.
 * Once a download is ready, checking stops: the installer runs on quit or on "Install now".
 */
export class UpdateController implements UpdatesService {
  private status: UpdateStatus = { status: 'idle' };
  private readonly cancels: (() => void)[] = [];
  private readonly restart: RestartService;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.restart = new RestartService({
      gates: deps.gates,
      // electron-updater quits on the next tick, so approving right after still comes first; an
      // installer that throws leaves the exit flow unapproved and the gates in charge.
      relaunch: () => {
        deps.port.quitAndInstall();
        deps.approveQuit();
      },
    });
  }

  start(): void {
    const { port, timers } = this.deps;
    port.onAvailable((version) => {
      this.deps.logger.info('update available', { version });
      this.set({ status: 'available', version });
    });
    port.onNotAvailable(() => {
      this.set({ status: 'idle' });
    });
    port.onProgress((percent) => {
      const version = 'version' in this.status ? this.status.version : '';
      const rounded = Math.min(100, Math.max(0, Math.floor(percent)));
      this.set({ status: 'downloading', version, percent: rounded });
    });
    port.onDownloaded((version) => {
      this.deps.logger.info('update downloaded', { version });
      this.set({ status: 'ready', version });
      this.stop();
    });
    port.onError((error) => {
      this.fail(error);
    });
    this.cancels.push(
      timers.after(this.deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS, () => {
        this.check();
      }),
      timers.every(this.deps.checkIntervalMs ?? CHECK_INTERVAL_MS, () => {
        this.check();
      }),
    );
  }

  stop(): void {
    for (const cancel of this.cancels.splice(0)) cancel();
  }

  state(): UpdateState {
    return { currentVersion: this.deps.currentVersion, update: this.status };
  }

  async install(): Promise<UpdateInstallOutcome> {
    if (this.status.status !== 'ready') return { status: 'failed', message: NOT_READY };
    const outcome = await this.restart.restart();
    if (outcome.status === 'failed') {
      this.deps.logger.error('update install failed', { message: outcome.message });
    }
    return outcome;
  }

  private check(): void {
    // A download in progress or a finished one needs no new check.
    if (this.status.status === 'downloading' || this.status.status === 'ready') return;
    try {
      void this.deps.port.check().catch((error: unknown) => {
        this.fail(error);
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const message = messageOf(error);
    // electron-updater both rejects and emits for one failure: report it once.
    if (this.status.status === 'error' && this.status.message === message) return;
    this.deps.logger.warn('update check failed', { message });
    // A downloaded update stays installable whatever a later check says.
    if (this.status.status === 'ready') return;
    this.set({ status: 'error', message });
  }

  private set(next: UpdateStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.deps.onChange(this.state());
  }
}

/** Dev, e2e and fake-native runs: always idle, nothing to install. */
export function disabledUpdates(currentVersion: string): UpdatesService {
  return {
    state: () => ({ currentVersion, update: { status: 'idle' } }),
    install: () => Promise.resolve({ status: 'failed', message: NOT_READY }),
  };
}

/** Only an installed release updates itself; dev, e2e and fake-native builds never check. */
export function updatesEnabled(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return isPackaged && env.VOZELLA_E2E !== '1' && env.VOZELLA_FAKE_NATIVE !== '1';
}
