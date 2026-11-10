import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron';

/** The native file dialogs, parented to the main window while there is one. */
export interface WindowDialogs {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
}

export function windowDialogs(getWindow: () => BrowserWindow | undefined): WindowDialogs {
  return {
    showOpenDialog: (options) => {
      const window = getWindow();
      return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
    },
    showSaveDialog: (options) => {
      const window = getWindow();
      return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
    },
  };
}
