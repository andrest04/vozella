import { describe, expect, it, vi } from 'vitest';
import { AppTray, type TrayLike, type TrayRecordingActions } from './app-tray';
import {
  buildTrayModel,
  trayMenuTemplate,
  trayRecordingState,
  type TrayActionId,
  type TrayMenuItem,
  type TrayRecordingState,
} from './tray-model';

const strings: Record<string, string> = {
  'LiveCopilot_OpenApp.ToolTipService.ToolTip': 'Open Vozella',
  'MeetingPrompt_Start.Content': 'Start recording',
  'LiveCopilot_Pause.AutomationProperties.Name': 'Pause recording',
  'LiveCopilot_Resume.AutomationProperties.Name': 'Resume recording',
  'LiveCopilot_Stop.AutomationProperties.Name': 'Stop recording',
  Ui_TrayQuit: 'Quit Vozella',
  Ui_TrayRecording: 'Vozella, recording',
  Ui_TrayPaused: 'Vozella, paused',
};
const t = (key: string): string => strings[key] ?? key;

const open = { id: 'open', label: 'Open Vozella', enabled: true } as const;
const quit = { id: 'quit', label: 'Quit Vozella', enabled: true } as const;

function model(recording: TrayRecordingState) {
  return buildTrayModel({ recording, t });
}

describe('trayRecordingState', () => {
  it('maps the recording phase and the pause to the tray state', () => {
    expect(trayRecordingState({ phase: 'Idle', isPaused: false })).toBe('idle');
    expect(trayRecordingState({ phase: 'Preparing', isPaused: false })).toBe('starting');
    expect(trayRecordingState({ phase: 'Recording', isPaused: false })).toBe('recording');
    expect(trayRecordingState({ phase: 'Recording', isPaused: true })).toBe('paused');
    expect(trayRecordingState({ phase: 'Stopping', isPaused: false })).toBe('stopping');
    expect(trayRecordingState({ phase: 'Processing', isPaused: false })).toBe('processing');
  });
});

describe('buildTrayModel', () => {
  it('idle: Start recording, then Open Vozella and Quit, and the plain name as tooltip', () => {
    expect(model('idle')).toEqual({
      tooltip: 'Vozella',
      items: [{ id: 'start', label: 'Start recording', enabled: true }, open, quit],
    });
  });

  it('recording: Pause and Stop recording, and says so in the tooltip', () => {
    expect(model('recording')).toEqual({
      tooltip: 'Vozella, recording',
      items: [
        { id: 'pause', label: 'Pause recording', enabled: true },
        { id: 'stop', label: 'Stop recording', enabled: true },
        open,
        quit,
      ],
    });
  });

  it('paused: Resume and Stop recording, and a paused tooltip', () => {
    expect(model('paused')).toEqual({
      tooltip: 'Vozella, paused',
      items: [
        { id: 'resume', label: 'Resume recording', enabled: true },
        { id: 'stop', label: 'Stop recording', enabled: true },
        open,
        quit,
      ],
    });
  });

  it('starting and processing: Start recording is shown but disabled', () => {
    for (const state of ['starting', 'processing'] as const) {
      expect(model(state).items).toEqual([
        { id: 'start', label: 'Start recording', enabled: false },
        open,
        quit,
      ]);
    }
    expect(model('starting').tooltip).toBe('Vozella');
    expect(model('processing').tooltip).toBe('Vozella');
  });

  it('stopping: Stop recording is shown but disabled; the tooltip still says recording', () => {
    expect(model('stopping')).toEqual({
      tooltip: 'Vozella, recording',
      items: [{ id: 'stop', label: 'Stop recording', enabled: false }, open, quit],
    });
  });
});

describe('trayMenuTemplate', () => {
  it('separates the recording actions from Open and Quit and runs the chosen id', () => {
    const run = vi.fn();
    const template = trayMenuTemplate(model('paused').items, run);
    expect(template.map((entry) => ('type' in entry ? entry.type : entry.label))).toEqual([
      'Resume recording',
      'Stop recording',
      'separator',
      'Open Vozella',
      'Quit Vozella',
    ]);
    const stop = template[1];
    if (stop === undefined || 'type' in stop) throw new Error('expected an action');
    stop.click();
    expect(run).toHaveBeenCalledWith('stop');
  });

  it('keeps the enabled flag of each action', () => {
    const template = trayMenuTemplate(model('stopping').items, vi.fn());
    expect(template[0]).toMatchObject({ label: 'Stop recording', enabled: false });
    expect(template.at(-1)).toMatchObject({ label: 'Quit Vozella', enabled: true });
  });
});

function setup() {
  const listeners = new Map<string, () => void>();
  let destroyed = false;
  const tray: TrayLike = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
  const open = vi.fn();
  const quit = vi.fn();
  const onActionError = vi.fn();
  const recording = {
    start: vi.fn<TrayRecordingActions['start']>(),
    pause: vi.fn<TrayRecordingActions['pause']>(() => Promise.resolve(true)),
    resume: vi.fn<TrayRecordingActions['resume']>(() => Promise.resolve(true)),
    stop: vi.fn<TrayRecordingActions['stop']>(() => Promise.resolve(true)),
  };
  let run: ((id: TrayActionId) => void) | undefined;
  let lastItems: readonly TrayMenuItem[] = [];
  const buildMenu = vi.fn((items: readonly TrayMenuItem[], runner: (id: TrayActionId) => void) => {
    run = runner;
    lastItems = items;
    return { menu: true };
  });
  const appTray = new AppTray({
    createTray: () => tray,
    buildMenu,
    t,
    open,
    quit,
    recording,
    onActionError,
  });
  return {
    appTray,
    tray,
    listeners,
    open,
    quit,
    recording,
    onActionError,
    buildMenu,
    ids: () => lastItems.map((item) => item.id),
    choose: (id: TrayActionId) => run?.(id),
  };
}

describe('AppTray', () => {
  it('sets the tooltip and an idle menu at creation', () => {
    const { tray, ids } = setup();
    expect(tray.setToolTip).toHaveBeenCalledWith('Vozella');
    expect(tray.setContextMenu).toHaveBeenCalledWith({ menu: true });
    expect(ids()).toEqual(['start', 'open', 'quit']);
  });

  it('opens the window on click and on double click', () => {
    const { listeners, open } = setup();
    listeners.get('click')?.();
    listeners.get('double-click')?.();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('runs open and quit from the menu, and quit goes to the gated quit only', () => {
    const { choose, open, quit, recording } = setup();
    choose('open');
    expect(open).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    choose('quit');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(recording.stop).not.toHaveBeenCalled();
  });

  it('sends start, pause, resume and stop to the recording, one call each', () => {
    const { choose, recording, open, quit } = setup();
    choose('start');
    choose('pause');
    choose('resume');
    choose('stop');
    expect(recording.start).toHaveBeenCalledTimes(1);
    expect(recording.pause).toHaveBeenCalledTimes(1);
    expect(recording.resume).toHaveBeenCalledTimes(1);
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('reports a failed recording action instead of leaving the rejection unhandled', async () => {
    const { choose, recording, onActionError } = setup();
    const error = new Error('capture busy');
    recording.stop.mockImplementationOnce(() => Promise.reject(error));
    choose('stop');
    await vi.waitFor(() => {
      expect(onActionError).toHaveBeenCalledWith('stop', error);
    });
  });

  it('rebuilds the menu and tooltip when the recording state changes, once per change', () => {
    const { appTray, tray, ids } = setup();
    appTray.setRecordingState('recording');
    appTray.setRecordingState('recording');
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Vozella, recording');
    expect(tray.setToolTip).toHaveBeenCalledTimes(2);
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(['pause', 'stop', 'open', 'quit']);
    appTray.setRecordingState('paused');
    expect(ids()).toEqual(['resume', 'stop', 'open', 'quit']);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Vozella, paused');
    appTray.setRecordingState('idle');
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Vozella');
    expect(ids()).toEqual(['start', 'open', 'quit']);
  });

  it('destroys the tray once and ignores later updates', () => {
    const { appTray, tray } = setup();
    appTray.destroy();
    appTray.destroy();
    appTray.setRecordingState('recording');
    expect(tray.destroy).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenCalledTimes(1);
  });
});
