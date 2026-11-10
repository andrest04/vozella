import { updatesStateChanged, type PayloadInputOf } from '@vozella/contracts';
import type { ExitGateRegistry, Logger } from '@vozella/core';
import type { IpcServerDeps } from '../ipc/ipc-server';
import { registerUpdatesHandlers } from '../ipc/updates-handlers';
import {
  UpdateController,
  disabledUpdates,
  updatesEnabled,
  type UpdaterPort,
  type UpdateTimers,
} from './update-controller';

export interface ComposeUpdatesDeps {
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly currentVersion: string;
  readonly logger: Logger;
  readonly server: IpcServerDeps;
  readonly gates: ExitGateRegistry;
  readonly approveQuit: () => void;
  readonly broadcast: (
    channel: typeof updatesStateChanged,
    payload: PayloadInputOf<typeof updatesStateChanged>,
  ) => void;
  /** The electron-updater edge, created only when updates run. */
  readonly createPort: () => UpdaterPort;
  readonly timers?: UpdateTimers;
}

export const nodeTimers: UpdateTimers = {
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
  every: (ms, run) => {
    const handle = setInterval(run, ms);
    handle.unref();
    return () => {
      clearInterval(handle);
    };
  },
};

/**
 * Automatic updates. The handlers always exist (the renderer asks for the state on every launch);
 * the checks run only in an installed release. Returns the stop for the quit path.
 */
export function composeUpdates(deps: ComposeUpdatesDeps): { stop: () => void } {
  if (!updatesEnabled(deps.isPackaged, deps.env)) {
    registerUpdatesHandlers({ server: deps.server, updates: disabledUpdates(deps.currentVersion) });
    return { stop: () => undefined };
  }
  const logger = deps.logger;
  let controller: UpdateController;
  try {
    controller = new UpdateController({
      port: deps.createPort(),
      currentVersion: deps.currentVersion,
      logger,
      timers: deps.timers ?? nodeTimers,
      gates: deps.gates,
      approveQuit: deps.approveQuit,
      onChange: (state) => {
        deps.broadcast(updatesStateChanged, state);
      },
    });
  } catch (error) {
    // A broken updater never stops the app; it just does not update.
    logger.error('updater unavailable', { error: String(error) });
    registerUpdatesHandlers({ server: deps.server, updates: disabledUpdates(deps.currentVersion) });
    return { stop: () => undefined };
  }
  registerUpdatesHandlers({ server: deps.server, updates: controller });
  controller.start();
  logger.info('automatic updates on', { version: deps.currentVersion });
  return {
    stop: () => {
      controller.stop();
    },
  };
}
