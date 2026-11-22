import type { Logger } from '@vozella/core';
import type { RunMode } from '@vozella/platform';

/**
 * The argument Windows passes when it starts Vozella at sign in. That start keeps the main window
 * off screen: the app waits in the tray and call detection runs. A later launch by the user goes
 * through the single instance lock and shows the window.
 */
export const HIDDEN_LAUNCH_ARG = '--vozella-hidden';

export const isHiddenLaunch = (argv: readonly string[]): boolean =>
  argv.includes(HIDDEN_LAUNCH_ARG);

/**
 * Whether the main window appears once it is ready. Automated runs keep their own rule (hidden
 * unless a test asks); every other start shows it, except the hidden start at sign in.
 */
export function showMainWindowOnReady(input: {
  readonly mode: RunMode;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
}): boolean {
  if (input.mode === 'test') return input.env.VOZELLA_E2E_SHOW === '1';
  return !isHiddenLaunch(input.argv);
}

/** The OS list of apps started at sign in. Windows matches an entry by its exact arguments. */
export interface LoginItemPort {
  isEnabled(args: readonly string[]): boolean;
  set(enabled: boolean, args: readonly string[]): void;
}

export interface OpenAtLoginDeps {
  readonly port: LoginItemPort;
  /** Only an installed build registers: a development run would register electron.exe. */
  readonly packaged: boolean;
  readonly logger: Logger;
}

const LOGIN_ARGS: readonly string[] = [HIDDEN_LAUNCH_ARG];

/** Mirrors the `openAtLogin` setting into the OS login items. Failures are logged, never thrown. */
export class OpenAtLogin {
  constructor(private readonly deps: OpenAtLoginDeps) {}

  /** The user changed the setting: write it now. */
  apply(enabled: boolean): void {
    this.run(enabled, () => {
      this.deps.port.set(enabled, LOGIN_ARGS);
      this.deps.logger.info('open at login changed', { enabled });
    });
  }

  /** Start up: the OS entry may have been removed or left behind; write only when it differs. */
  reconcile(enabled: boolean): void {
    this.run(enabled, () => {
      if (this.deps.port.isEnabled(LOGIN_ARGS) === enabled) return;
      this.deps.port.set(enabled, LOGIN_ARGS);
      this.deps.logger.info('open at login restored', { enabled });
    });
  }

  private run(enabled: boolean, write: () => void): void {
    if (!this.deps.packaged) {
      this.deps.logger.info('open at login skipped: not a packaged build', { enabled });
      return;
    }
    try {
      write();
    } catch (error) {
      this.deps.logger.warn('open at login could not be written', {
        enabled,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
