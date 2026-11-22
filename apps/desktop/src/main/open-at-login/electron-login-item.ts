import type { App } from 'electron';
import type { LoginItemPort } from './open-at-login';

/**
 * The Electron login item API behind the port. On Windows it is the per-user Run key for this
 * executable, matched by path and arguments.
 */
export function electronLoginItem(
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>,
): LoginItemPort {
  return {
    isEnabled: (args) => app.getLoginItemSettings({ args: [...args] }).openAtLogin,
    set: (enabled, args) => {
      app.setLoginItemSettings({ openAtLogin: enabled, args: [...args] });
    },
  };
}
