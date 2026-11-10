import type { PillStateDto } from '@vozella/contracts';
import type { Logger, SettingsStore } from '@vozella/core';
import type { BrowserWindow } from 'electron';
import { screen, systemPreferences, type Display } from 'electron';
import {
  createPillBrowserWindow,
  pillPreloadPath,
  pillWindowOptions,
  PILL_ENTRY_URL,
} from '../windows/pill-window';
import type { IpcServerDeps } from '../ipc/ipc-server';
import { registerPillHandlers } from '../ipc/pill-handlers';
import { PillController, type PillDisplay, type PillScreenPort } from './pill-controller';
import { PillDockStore } from './pill-dock-store';

export interface ComposePillDeps {
  readonly settings: Pick<SettingsStore, 'load' | 'update'>;
  /** Already scoped to the pill (`logger.child('pill')`). */
  readonly logger: Logger;
  /** The localized `LiveCopilot_Title`. */
  readonly title: () => string;
  /** The renderer entry; the dev server URL in dev, the app scheme page otherwise. */
  readonly entryUrl?: string;
  readonly trustSender: (webContentsId: number) => void;
  readonly getMainWindow: () => BrowserWindow | null;
  /** The "meeting detected" popup goes away when a take starts. */
  readonly dismissMeetingPopup: () => void;
}

const toDisplay = (display: Display): PillDisplay => ({
  id: display.id,
  workArea: display.workArea,
  bounds: display.bounds,
});

/** Electron's `screen`, in DIP like the window bounds (see the decision in pill-controller.ts). */
export const electronPillScreen: PillScreenPort = {
  primaryWorkArea: () => screen.getPrimaryDisplay().workArea,
  displayAt: (point) => toDisplay(screen.getDisplayNearestPoint(point)),
  allDisplays: () => screen.getAllDisplays().map(toDisplay),
  onDisplayChanged: (listener) => {
    screen.on('display-removed', listener);
    screen.on('display-metrics-changed', listener);
    return () => {
      screen.removeListener('display-removed', listener);
      screen.removeListener('display-metrics-changed', listener);
    };
  },
};

/** The pill controller wired to Electron. Nothing is created until the pill is first needed. */
export function composePill(deps: ComposePillDeps): PillController {
  const logger = deps.logger;
  return new PillController({
    createWindow: () =>
      createPillBrowserWindow(
        pillWindowOptions(pillPreloadPath(), deps.title()),
        deps.entryUrl ?? PILL_ENTRY_URL,
      ),
    screen: electronPillScreen,
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      setInterval: (run, ms) => {
        const timer = setInterval(run, ms);
        return () => {
          clearInterval(timer);
        };
      },
    },
    dock: new PillDockStore(deps.settings, logger),
    // The Windows "animation effects" switch; elsewhere the platform default is on.
    animationsEnabled: () => systemPreferences.getAnimationSettings().shouldRenderRichAnimation,
    trustSender: deps.trustSender,
    handoff: {
      dismissMeetingPopup: deps.dismissMeetingPopup,
      minimizeMainWindow: () => {
        const main = deps.getMainWindow();
        if (!main || main.isDestroyed()) return false;
        // A main window that is not on screen is not in front either: nothing to minimize.
        if (!main.isVisible() || main.isMinimized()) return true;
        if (!main.isMinimizable()) return false;
        main.minimize();
        return main.isMinimized();
      },
    },
    logger,
  });
}

/** What `pill.ready` answers in the moment between the pill closing and the app quitting. */
export const NO_PILL_STATE: PillStateDto = {
  visible: false,
  expanded: false,
  edge: 'Right',
  vertical: true,
  animationsEnabled: false,
  opacity: 1,
  contentOpacity: 1,
  window: { width: 80, height: 256 },
  capsule: { x: 8, y: 8, width: 64, height: 240 },
  panel: null,
};

export interface ComposePillHandlersDeps {
  readonly server: IpcServerDeps;
  /** The pill of the current main window; undefined once that window closed. */
  readonly getPill: () => PillController | undefined;
  readonly recording: {
    getState(): { readonly isPaused: boolean };
    pause(): Promise<unknown>;
    resume(): Promise<unknown>;
    stop(): Promise<unknown>;
  };
  readonly openApp: () => void;
  /** The pill page just loaded: replay the live ask state it missed. */
  readonly republishLiveAsk: () => void;
}

/** The pill buttons wired to the recording service and the pill controller. */
export function composePillHandlers(deps: ComposePillHandlersDeps): void {
  registerPillHandlers(deps.server, {
    togglePause: async () => {
      if (deps.recording.getState().isPaused) await deps.recording.resume();
      else await deps.recording.pause();
    },
    stop: async () => {
      await deps.recording.stop();
    },
    openApp: deps.openApp,
    setExpanded: (expanded) => deps.getPill()?.setExpanded(expanded) ?? NO_PILL_STATE,
    state: () => deps.getPill()?.state ?? NO_PILL_STATE,
    ready: deps.republishLiveAsk,
  });
}
