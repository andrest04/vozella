import { autoUpdater } from 'electron-updater';
import type { Logger } from '@vozella/core';
import type { UpdaterPort } from './update-controller';

/**
 * The electron-updater edge. The feed comes from the app-update.yml electron-builder writes into
 * resources (publish: GitHub). Downloads start by themselves and install when the app quits.
 * Only created in packaged builds: the autoUpdater getter reads that file on first use.
 */
export function createElectronUpdaterPort(logger: Logger): UpdaterPort {
  const updater = autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  // Its own messages go to the app log at debug level; failures are logged by the controller.
  updater.logger = {
    info: (message?: unknown) => {
      logger.debug('updater', { message: String(message) });
    },
    warn: (message?: unknown) => {
      logger.debug('updater warning', { message: String(message) });
    },
    error: (message?: unknown) => {
      logger.debug('updater error', { message: String(message) });
    },
    debug: (message: string) => {
      logger.debug('updater', { message });
    },
  };
  return {
    onAvailable: (listener) => {
      updater.on('update-available', (info) => {
        listener(info.version);
      });
    },
    onNotAvailable: (listener) => {
      updater.on('update-not-available', () => {
        listener();
      });
    },
    onProgress: (listener) => {
      updater.on('download-progress', (progress) => {
        listener(progress.percent);
      });
    },
    onDownloaded: (listener) => {
      updater.on('update-downloaded', (info) => {
        listener(info.version);
      });
    },
    onError: (listener) => {
      updater.on('error', (error) => {
        listener(error);
      });
    },
    check: () => updater.checkForUpdates(),
    // Silent install (the assisted installer would show its wizard), then start the app again.
    quitAndInstall: () => {
      updater.quitAndInstall(true, true);
    },
  };
}
