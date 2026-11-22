import path from 'node:path';
import type { WindowPlacement } from '@vozella/core';
import { BrowserWindow } from 'electron';
import { APP_ENTRY_URL } from '../security/trusted-origin';
import { mainWindowOptions, whenToMaximize } from './main-window-options';
import type { ResolvedTheme } from './title-bar-theme';

export interface MainWindowOptions {
  /** Vite dev server URL, only set when running `electron-vite dev`. */
  readonly devServerUrl: string | undefined;
  /** Hide the window (automated runs and smoke checks). */
  readonly showOnReady: boolean;
  /** A start at sign in: the window stays in the tray until the user opens it. */
  readonly startInTray: boolean;
  /** Theme at creation, so the first paint and the caption buttons already match. */
  readonly theme: ResolvedTheme;
  /** Saved or default geometry (window-state.json). */
  readonly placement: WindowPlacement;
  /** Absolute path of the window icon. */
  readonly iconPath: string;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow(
    mainWindowOptions({
      theme: options.theme,
      placement: options.placement,
      iconPath: options.iconPath,
      preloadPath: path.join(__dirname, '../preload/index.js'),
    }),
  );
  // The constructor adds a few pixels of frame to a given position and size at a fractional
  // display scale; setting the bounds again brings it within a pixel or two of what was asked.
  const { bounds } = options.placement;
  if (bounds.x !== undefined && bounds.y !== undefined) {
    window.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }
  const maximize = whenToMaximize({
    maximized: options.placement.maximized,
    startInTray: options.startInTray,
  });
  if (maximize === 'now') window.maximize();
  else if (maximize === 'on-show') window.once('show', () => window.maximize());

  window.once('ready-to-show', () => {
    if (options.showOnReady) window.show();
  });

  void window.loadURL(options.devServerUrl ?? APP_ENTRY_URL);
  return window;
}
