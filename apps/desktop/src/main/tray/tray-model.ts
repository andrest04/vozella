import type { RecordingStateDto } from '@vozella/contracts';

export type TrayActionId = 'start' | 'pause' | 'resume' | 'stop' | 'open' | 'quit';

/** What the tray shows of the recording: the phase, with the pause split out of `Recording`. */
export type TrayRecordingState =
  'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'processing';

export interface TrayMenuItem {
  readonly id: TrayActionId;
  readonly label: string;
  /** False while the action is already under way (start or stop in progress, processing). */
  readonly enabled: boolean;
}

export interface TrayModel {
  /** The hover text: the product name, or the recording state. */
  readonly tooltip: string;
  readonly items: readonly TrayMenuItem[];
}

/**
 * Catalog keys. Open reuses "Open Vozella", start reuses the call popup's "Start recording", and
 * pause, resume and stop reuse the pill's labels.
 */
export const TRAY_KEYS = {
  open: 'LiveCopilot_OpenApp.ToolTipService.ToolTip',
  quit: 'Ui_TrayQuit',
  start: 'MeetingPrompt_Start.Content',
  pause: 'LiveCopilot_Pause.AutomationProperties.Name',
  resume: 'LiveCopilot_Resume.AutomationProperties.Name',
  stop: 'LiveCopilot_Stop.AutomationProperties.Name',
  recording: 'Ui_TrayRecording',
  paused: 'Ui_TrayPaused',
} as const;

/** The tray state of a published recording state. */
export function trayRecordingState(
  state: Pick<RecordingStateDto, 'phase' | 'isPaused'>,
): TrayRecordingState {
  switch (state.phase) {
    case 'Idle':
      return 'idle';
    case 'Preparing':
      return 'starting';
    case 'Recording':
      return state.isPaused ? 'paused' : 'recording';
    case 'Stopping':
      return 'stopping';
    case 'Processing':
      return 'processing';
  }
}

/** The recording actions for each state; the second value says whether they can run now. */
const RECORDING_ITEMS: Record<
  TrayRecordingState,
  readonly { readonly id: 'start' | 'pause' | 'resume' | 'stop'; readonly enabled: boolean }[]
> = {
  idle: [{ id: 'start', enabled: true }],
  starting: [{ id: 'start', enabled: false }],
  recording: [
    { id: 'pause', enabled: true },
    { id: 'stop', enabled: true },
  ],
  paused: [
    { id: 'resume', enabled: true },
    { id: 'stop', enabled: true },
  ],
  stopping: [{ id: 'stop', enabled: false }],
  // A new take waits for the processing to end; the service answers busy until then.
  processing: [{ id: 'start', enabled: false }],
};

function tooltipFor(recording: TrayRecordingState, t: (key: string) => string): string {
  if (recording === 'recording' || recording === 'stopping') return t(TRAY_KEYS.recording);
  if (recording === 'paused') return t(TRAY_KEYS.paused);
  return 'Vozella';
}

/** The tray menu and tooltip, as plain data so the rule is testable without Electron. */
export function buildTrayModel(input: {
  readonly recording: TrayRecordingState;
  readonly t: (key: string) => string;
}): TrayModel {
  const { recording, t } = input;
  return {
    tooltip: tooltipFor(recording, t),
    items: [
      ...RECORDING_ITEMS[recording].map((item) => ({
        id: item.id,
        label: t(TRAY_KEYS[item.id]),
        enabled: item.enabled,
      })),
      { id: 'open', label: t(TRAY_KEYS.open), enabled: true },
      { id: 'quit', label: t(TRAY_KEYS.quit), enabled: true },
    ],
  };
}

export type TrayMenuEntry =
  | { readonly type: 'separator' }
  | { readonly label: string; readonly enabled: boolean; readonly click: () => void };

/**
 * The template `Menu.buildFromTemplate` takes: the recording actions, a separator, then Open and
 * Quit. Plain objects, so the order and the separator are testable without Electron.
 */
export function trayMenuTemplate(
  items: readonly TrayMenuItem[],
  run: (id: TrayActionId) => void,
): TrayMenuEntry[] {
  const entries: TrayMenuEntry[] = [];
  items.forEach((item, index) => {
    if (item.id === 'open' && index > 0) entries.push({ type: 'separator' });
    entries.push({
      label: item.label,
      enabled: item.enabled,
      click: () => {
        run(item.id);
      },
    });
  });
  return entries;
}
