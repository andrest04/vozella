import {
  buildTrayModel,
  type TrayActionId,
  type TrayMenuItem,
  type TrayRecordingState,
} from './tray-model';

/** The slice of Electron's Tray the app uses. */
export interface TrayLike {
  setToolTip(tooltip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click' | 'double-click', listener: () => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}

/**
 * The recording verbs the menu calls. They are the same calls the pill and the call popup make,
 * so the service keeps every rule (a refused pause or stop simply answers false).
 */
export interface TrayRecordingActions {
  /** A blank take through the take-notes request, as the call popup's Start does. */
  start(): void;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface AppTrayDeps {
  readonly createTray: () => TrayLike;
  /** Builds a native menu from the model, calling `run` with the chosen action. */
  readonly buildMenu: (items: readonly TrayMenuItem[], run: (id: TrayActionId) => void) => unknown;
  readonly t: (key: string) => string;
  /** Show, restore and focus the main window (the activation helper). */
  readonly open: () => void;
  /** Quit through the exit gate; it must never bypass it. */
  readonly quit: () => void;
  readonly recording: TrayRecordingActions;
  /** A recording action that threw or rejected; the menu has nowhere to show it. */
  readonly onActionError: (id: TrayActionId, error: unknown) => void;
}

/**
 * The tray icon. The window still closes the app, so the tray lives and dies
 * with the window; it brings the window back after the recording start minimized it, and starts,
 * pauses, resumes and stops a take without it.
 */
export class AppTray {
  private readonly tray: TrayLike;
  private recording: TrayRecordingState = 'idle';

  constructor(private readonly deps: AppTrayDeps) {
    this.tray = deps.createTray();
    this.tray.on('click', deps.open);
    this.tray.on('double-click', deps.open);
    this.render();
  }

  /** Feed every published recording state; repeats do not rebuild the menu. */
  setRecordingState(state: TrayRecordingState): void {
    if (state === this.recording) return;
    this.recording = state;
    this.render();
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }

  private render(): void {
    if (this.tray.isDestroyed()) return;
    const model = buildTrayModel({ recording: this.recording, t: this.deps.t });
    this.tray.setToolTip(model.tooltip);
    this.tray.setContextMenu(
      this.deps.buildMenu(model.items, (id) => {
        this.run(id);
      }),
    );
  }

  private run(id: TrayActionId): void {
    const { deps } = this;
    if (id === 'open') {
      deps.open();
      return;
    }
    if (id === 'quit') {
      deps.quit();
      return;
    }
    try {
      Promise.resolve(deps.recording[id]()).catch((error: unknown) => {
        deps.onActionError(id, error);
      });
    } catch (error) {
      deps.onActionError(id, error);
    }
  }
}
