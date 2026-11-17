// @vitest-environment jsdom
import type { RecordingSetupDto, RecordingStateDto } from '@vozella/contracts';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderRouted } from '../../test-support/render-with-router';
import { RecordRoute } from './RecordRoute';
import { applyAnswer, resetLiveAskStore } from './use-live-ask';
import { resetRecordingStore } from './use-recording';

type Listener = (payload: unknown) => void;
type Handler = (input: Record<string, unknown>) => unknown;

const system = { processId: null, app: null, isAvailable: true, level: 0 };
const pickerState = {
  cards: [system],
  selectedProcessId: null,
  noAppsPlaying: true,
  fallbackAppName: null,
};

const idleState: RecordingStateDto = {
  phase: 'Idle',
  isRecording: false,
  isPaused: false,
  isProcessing: false,
  elapsedMs: 0,
  elapsedAsOfMs: 0,
  isTicking: false,
  status: [],
  micLevel: 0,
  microphoneActive: true,
  captureNotices: [],
  liveNotice: null,
  meetingId: null,
  projectId: null,
  title: '',
  recordedAtMs: null,
  highlightCount: 0,
  notes: '',
  canRetry: false,
  lastMeeting: null,
};

const card = (header: string, ready: boolean) => ({
  headerKey: header,
  status: { key: ready ? 'RecordingSetup_Ready' : 'RecordingSetup_NeedsSetup', args: [] },
  detail: { key: 'RecordingSetup_EngineDetail', args: [] },
  ready,
});

const readySetup: RecordingSetupDto = {
  canRecord: true,
  live: card('RecordingSetup_Live.Header', true),
  engine: card('RecordingSetup_Engine.Header', true),
  summary: card('RecordingSetup_Summary.Header', true),
  summaryProviderRemoved: false,
  idleStatus: { key: 'Status_ReadyToRecord', args: [] },
  provider: 'Local',
};

const needsSetup: RecordingSetupDto = {
  ...readySetup,
  canRecord: false,
  engine: card('RecordingSetup_Engine.Header', false),
  idleStatus: { key: 'Status_NeedsSetup', args: [] },
};

const project = (id: string, name: string, pinned = false) => ({
  id,
  name,
  description: '',
  pinned,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  meetingCount: 0,
  fileCount: 0,
  lastActivityAt: '2026-09-01T12:00:00.000Z',
});

const P_BETA = '00000000-0000-4000-8000-0000000000b1';
const P_ALPHA = '00000000-0000-4000-8000-0000000000a1';
const P_PINNED = '00000000-0000-4000-8000-0000000000c1';

function installApi(overrides: Record<string, Handler> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const handlers: Record<string, Handler> = {
    'audio.microphones.load': () => ({
      options: [
        { kind: 'None', deviceId: null, name: null },
        { kind: 'SystemDefault', deviceId: null, name: null },
      ],
      selected: { kind: 'SystemDefault', deviceId: null },
    }),
    'audio.sources.start': () => pickerState,
    'transcription.getStatus': () => ({ ready: true, liveEnabled: false }),
    'recording.getState': () => ({ ...idleState, liveText: '' }),
    'recording.getSetup': () => readySetup,
    'projects.list': () => ({
      projects: [
        project(P_BETA, 'beta'),
        project(P_ALPHA, 'Alpha'),
        project(P_PINNED, 'Zeta', true),
      ],
      noProject: { meetingCount: 0, lastActivityAt: null },
      skipped: [],
      storage: { status: 'ready' },
    }),
    'recording.start': () => ({ started: true, meetingId: 'm1', recordedAtMs: 1 }),
    'recording.stop': () => ({ stopped: true }),
    ...overrides,
  };
  const invoke = (name: string, input: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, input });
    const handler = handlers[name];
    return Promise.resolve(handler ? handler(input) : {});
  };
  const on = (name: string, listener: Listener) => {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return () => {
      set.delete(listener);
    };
  };
  Object.defineProperty(window, 'vozella', {
    value: { invoke, on },
    configurable: true,
    writable: true,
  });
  const emit = (name: string, payload: unknown): void => {
    act(() => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    });
  };
  const named = (name: string) => calls.filter((call) => call.name === name);
  return { calls, emit, named };
}

beforeEach(() => {
  resetRecordingStore();
  resetLiveAskStore();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const mount = (initial = '/record') =>
  renderRouted(initial, [{ path: '/record', component: RecordRoute }]);

describe('RecordRoute idle zone', () => {
  it('shows the default title, the destination list and the hero when ready', async () => {
    installApi();
    await mount();
    expect(await screen.findByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import audio' })).toBeEnabled();
    expect(screen.queryByTestId('setup-checklist')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toMatch(
      /^Meeting \d{1,2} \w{3}, \d{2}:\d{2}$/,
    );
    expect(screen.queryByText('Ready to record.')).toBeNull();
    await userEvent.click(screen.getByRole('combobox', { name: 'Save to' }));
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    // No project first, then the pinned projects, then the rest by name.
    expect(options).toEqual(['No project', 'Zeta', 'Alpha', 'beta']);
  });

  it('starts with the typed title and the chosen sources', async () => {
    const api = installApi();
    await mount();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Weekly');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
    expect(api.named('recording.start')[0]?.input).toEqual({
      title: 'Weekly',
      projectId: null,
      microphone: { kind: 'SystemDefault', deviceId: null },
      processId: null,
      appName: null,
    });
    // The readiness was read again before the start.
    expect(api.named('recording.getSetup').length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    [false, 'The live preview is off. The transcript is made after you stop.'],
    [true, /Live preview only/],
  ])(
    '105: with live transcription %s the empty canvas says the matching thing',
    async (liveEnabled, hint) => {
      installApi({
        'transcription.getStatus': () => ({ ready: true, liveEnabled }),
        'recording.getState': () => ({
          ...idleState,
          phase: 'Recording',
          isRecording: true,
          liveText: '',
        }),
      });
      await mount();
      expect(await screen.findByText(hint)).toBeInTheDocument();
    },
  );

  it('shows the title in the bar while recording, with the fields out of the way, and unlocks the title while processing', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Recording',
        isRecording: true,
        title: 'Live take',
        liveText: '',
      }),
    });
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId('bar-title')).toHaveTextContent('Live take');
    });
    // The fields stay mounted so the sources keep their state, but are not drawn.
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Save to' })).toBeNull();
    cleanup();
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Processing',
        isProcessing: true,
        liveText: '',
      }),
    });
    resetRecordingStore();
    await mount();
    await screen.findByTestId('record-session');
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeEnabled();
  });

  it('draws a new default title when the take ends', async () => {
    const api = installApi();
    await mount();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'First take');
    api.emit('recording.state', { ...idleState, phase: 'Processing', isProcessing: true });
    api.emit('recording.state', idleState);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toMatch(
        /^Meeting /,
      );
    });
  });
});

describe('RecordRoute idle document (the title is the heading)', () => {
  const subtitle = /Set up your meeting, then record it/;

  it('keeps one h1 for assistive tech, no subtitle and an unlabeled but named title', async () => {
    installApi();
    await mount();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toBeEnabled();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Record meeting' })).toBeInTheDocument();
    expect(screen.queryByText(subtitle)).toBeNull();
    expect(screen.queryByText('Title')).toBeNull();
  });

  it('shows the destination as one visible label and a select', async () => {
    installApi();
    await mount();
    await screen.findByRole('combobox', { name: 'Save to' });
    expect(screen.getAllByText('Save to')).toHaveLength(1);
  });

  it('keeps the subtitle and the labeled fields while processing', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Processing',
        isProcessing: true,
        liveText: '',
      }),
    });
    await mount();
    await screen.findByTestId('record-session');
    expect(screen.getByRole('heading', { level: 1, name: 'Record meeting' })).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeEnabled();
  });
});

describe('RecordRoute action row', () => {
  const helper = 'Transcript and summary are created after you stop.';

  it('holds Record, Import and the helper when ready', async () => {
    installApi();
    await mount();
    const row = await screen.findByTestId('record-actions');
    expect(within(row).getByTestId('record-hero')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Import audio' })).toBeEnabled();
    expect(within(row).getByText(helper)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Set up to record' })).toBeNull();
  });

  it('holds only Set up to record while setup is missing', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    const row = screen.getByTestId('record-actions');
    expect(within(row).getByRole('button', { name: 'Set up to record' })).toBeEnabled();
    expect(within(panel).queryByRole('button', { name: 'Set up to record' })).toBeNull();
    expect(within(row).queryByTestId('record-hero')).toBeNull();
    expect(screen.queryByText(helper)).toBeNull();
  });

  it('sits after the result card and the saved transcript, so it stays reachable below them', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        lastMeeting: { id: 'm-9', title: 'Weekly sync' },
        liveText: 'Hello there',
      }),
    });
    await mount();
    const row = await screen.findByTestId('record-actions');
    const transcript = await screen.findByTestId('saved-transcript');
    expect(transcript.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('is not drawn during a take or while processing', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Processing',
        isProcessing: true,
        liveText: '',
      }),
    });
    await mount();
    await screen.findByTestId('record-session');
    expect(screen.queryByTestId('record-actions')).toBeNull();
  });

  it('keeps a refusal next to the button that caused it', async () => {
    installApi({
      'recording.start': () => ({
        started: false,
        reason: 'failed',
        message: { key: 'Error_StartRecording', args: ['disk full'], severity: 'error' },
      }),
    });
    await mount();
    const row = await screen.findByTestId('record-actions');
    await userEvent.click(within(row).getByRole('button', { name: 'Record' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('disk full');
  });
});

describe('RecordRoute setup', () => {
  it('shows the inline panel with the three cards instead of the hero', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    expect(within(panel).getAllByTestId('setup-card')).toHaveLength(3);
    expect(within(panel).getByText('Needs setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up to record' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import audio' })).toBeNull();
    expect(screen.queryByText('Set up recording before you start.')).toBeNull();
  });

  it('heads the panel with what to do and keeps the download fact in one line', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    expect(
      within(panel).getByRole('heading', { level: 2, name: 'Finish setup to record' }),
    ).toBeInTheDocument();
    expect(panel).toHaveAccessibleName('Finish setup to record');
    expect(within(panel).getByText('Nothing downloads once a recording starts.')).toBeVisible();
    expect(panel).not.toHaveTextContent('Install what is needed');
  });

  it('marks only ready rows with a glyph and always says the state in words', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    const [ready, pending] = within(panel).getAllByTestId('setup-card');
    if (!ready || !pending) throw new Error('expected the setup rows');
    expect(ready).toHaveTextContent('Ready');
    expect(ready.querySelectorAll('svg')).toHaveLength(1);
    expect(pending).toHaveTextContent('Needs setup');
    expect(pending.querySelector('svg')).toBeNull();
    expect(within(panel).queryAllByRole('radio')).toHaveLength(0);
  });

  it('names the rows by what they do', async () => {
    installApi({
      'recording.getSetup': () => ({
        ...needsSetup,
        live: {
          ...card('RecordingSetup_Live.Header', false),
          detail: { key: 'RecordingSetup_LiveNotNeededDetail', args: [] },
        },
      }),
    });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    const [live, engine] = within(panel).getAllByTestId('setup-card');
    expect(live).toHaveTextContent('Live captions');
    expect(live).toHaveTextContent(
      'Live captions are off. The transcript is still created after you stop.',
    );
    expect(engine).toHaveTextContent('Transcript');
    expect(panel).not.toHaveTextContent('Nemo');
  });

  it('asks the removed provider to be replaced', async () => {
    installApi({
      'recording.getSetup': () => ({
        ...needsSetup,
        summaryProviderRemoved: true,
        provider: 'Xai',
      }),
    });
    await mount();
    expect(await screen.findByTestId('TxtProviderUnavailable')).toHaveTextContent(
      'Grok (xAI) is no longer available',
    );
  });

  it('a refused Record opens the dialog, and Cancel leaves everything as it was', async () => {
    let setup = readySetup;
    const api = installApi({ 'recording.getSetup': () => setup });
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    setup = needsSetup;
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    expect(within(dialog).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.named('recording.start')).toHaveLength(0);
    expect(await screen.findByText('Setup cancelled.')).toBeInTheDocument();
  });

  it('Set up runs the engine step first, then the loop reads the snapshot again and records', async () => {
    let setup = needsSetup;
    const api = installApi({
      'recording.getSetup': () => setup,
      'transcription.ensureEngine': () => {
        setup = readySetup;
        return { status: 'ready' };
      },
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up to record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set up' }));
    await waitFor(() => {
      expect(api.named('transcription.ensureEngine').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('setup-checklist')).toBeNull();
  });
});

describe('RecordRoute idle repeats', () => {
  it('does not draw the sources summary while idle, and still reports it for the take', async () => {
    installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    await waitFor(() => {
      expect(screen.getByTestId('sources-summary')).toHaveTextContent('Mic: System default');
    });
    expect(screen.getByTestId('sources-summary')).not.toBeVisible();
  });

  it('keeps the sources heading for assistive tech while idle', async () => {
    installApi();
    await mount();
    expect(await screen.findByRole('heading', { level: 2, name: 'Sources' })).toBeInTheDocument();
  });

  it('draws the summary while processing, as before', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Processing',
        isProcessing: true,
        liveText: '',
      }),
    });
    await mount();
    await screen.findByTestId('record-session');
    expect(screen.getByTestId('sources-summary')).toBeVisible();
  });

  it('keeps a cancelled setup notice with the setup panel showing', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up to record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Setup cancelled.')).toBeInTheDocument();
  });

  it('keeps an error and its retry with the setup panel showing', async () => {
    installApi({
      'recording.getSetup': () => needsSetup,
      'recording.getState': () => ({
        ...idleState,
        canRetry: true,
        status: [{ key: 'Error_ProcessRecording', args: ['disk full'], severity: 'error' }],
        liveText: '',
      }),
    });
    await mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(screen.getByRole('button', { name: 'Try saving again' })).toBeInTheDocument();
  });
});

describe('RecordRoute accelerator and missing steps', () => {
  it('Ctrl+R starts a take on the idle page', async () => {
    const api = installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    await userEvent.keyboard('{Control>}r{/Control}');
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
  });

  it('with the engine ready, the summary chooser is the next step and cancelling it loops back to the checklist', async () => {
    const needsSummary: RecordingSetupDto = {
      ...readySetup,
      canRecord: false,
      summary: card('RecordingSetup_Summary.Header', false),
      idleStatus: { key: 'Status_NeedsSetup', args: [] },
    };
    const api = installApi({ 'recording.getSetup': () => needsSummary });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up to record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set up' }));
    const wizard = await screen.findByRole('dialog', { name: 'Set up summary generation' });
    expect(api.named('transcription.ensureEngine')).toHaveLength(0);
    await userEvent.click(within(wizard).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Set up recording' })).toBeInTheDocument();
    expect(api.named('recording.start')).toHaveLength(0);
  });

  it('an API engine sent to Settings for its key ends the setup without showing the checklist again', async () => {
    const needsSummary: RecordingSetupDto = {
      ...readySetup,
      canRecord: false,
      summary: card('RecordingSetup_Summary.Header', false),
      idleStatus: { key: 'Status_NeedsSetup', args: [] },
    };
    const api = installApi({
      'recording.getSetup': () => needsSummary,
      'settings.setSummaryProvider': () => ({ status: 'saved', settings: {}, feedback: null }),
      'summaries.providerStatus': () => ({
        status: 'needs-setup',
        kind: 'OpenAi',
        reason: 'key-missing',
      }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up to record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set up' }));
    const wizard = await screen.findByRole('dialog', { name: 'Set up summary generation' });
    await userEvent.click(within(wizard).getByTestId('BtnEngineOpenAi'));
    await waitFor(() => {
      expect(api.named('workspace.dispatch').map((call) => call.input)).toContainEqual({
        action: { type: 'navigateTo', tag: 'Settings' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText('Setup cancelled.')).toBeNull();
    expect(api.named('recording.start')).toHaveLength(0);
  });
});

describe('RecordRoute with a cloud transcription engine', () => {
  /** Groq is selected for transcription and its key is not saved. */
  const needsKey: RecordingSetupDto = {
    ...readySetup,
    canRecord: false,
    engine: {
      ...card('RecordingSetup_Engine.Header', false),
      detail: { key: 'Ui_ApiKeyMissing', args: ['Groq'] },
      reason: 'key-missing',
    },
    idleStatus: { key: 'Status_NeedsSetup', args: [] },
  };
  const toSettings = { action: { type: 'navigateTo', tag: 'Settings' } };

  it('says the key is what is missing, and that nothing is downloaded', async () => {
    installApi({ 'recording.getSetup': () => needsKey });
    await mount();
    const panel = await screen.findByTestId('setup-checklist');
    expect(
      within(panel).getByText('Add your Groq API key to record. Nothing needs to be downloaded.'),
    ).toBeVisible();
    expect(panel).not.toHaveTextContent('Nothing downloads once a recording starts.');
    const [, engine] = within(panel).getAllByTestId('setup-card');
    expect(engine).toHaveTextContent('Transcript');
    expect(engine).toHaveTextContent('Groq needs your API key. Add it in Settings.');
    expect(engine).toHaveTextContent('Needs setup');
  });

  it('offers one action, which opens Settings on the key and never the download', async () => {
    const api = installApi({ 'recording.getSetup': () => needsKey });
    await mount();
    const add = await screen.findByRole('button', { name: 'Add API key' });
    expect(screen.queryByRole('button', { name: 'Set up to record' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
    await userEvent.click(add);
    await waitFor(() => {
      expect(api.named('workspace.dispatch').map((call) => call.input)).toContainEqual(toSettings);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.named('transcription.ensureEngine')).toHaveLength(0);
    expect(api.named('recording.start')).toHaveLength(0);
  });

  it('a Record refused for the key opens the checklist with the same action, not the download', async () => {
    let setup = readySetup;
    const api = installApi({ 'recording.getSetup': () => setup });
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    // The key was removed after the page read the setup.
    setup = needsKey;
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up recording' });
    expect(dialog).toHaveAccessibleDescription(
      'Add your Groq API key to record. Nothing needs to be downloaded.',
    );
    expect(within(dialog).queryByRole('button', { name: 'Set up' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add API key' }));
    await waitFor(() => {
      expect(api.named('workspace.dispatch').map((call) => call.input)).toContainEqual(toSettings);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText('Download transcription engine')).toBeNull();
    expect(screen.queryByText('Download failed')).toBeNull();
    expect(api.named('transcription.ensureEngine')).toHaveLength(0);
    expect(screen.queryByText('Setup cancelled.')).toBeNull();
    expect(api.named('recording.start')).toHaveLength(0);
  });

  it('the local download dialog offers the cloud instead, which opens Settings and selects nothing', async () => {
    const api = installApi({
      'recording.getSetup': () => needsSetup,
      'transcription.ensureEngine': () => new Promise(() => undefined),
      'transcription.cancelInstall': () => ({ cancelled: true }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up to record' }));
    const checklist = await screen.findByRole('dialog', { name: 'Set up recording' });
    await userEvent.click(within(checklist).getByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download transcription engine' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use the cloud instead' }));
    await waitFor(() => {
      expect(api.named('workspace.dispatch').map((call) => call.input)).toContainEqual(toSettings);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.named('transcription.cancelInstall')).toHaveLength(1);
    expect(api.named('settings.update')).toHaveLength(0);
    expect(screen.queryByText('Setup cancelled.')).toBeNull();
  });

  it('reads the setup again when main says the engine or its key changed', async () => {
    let setup = needsKey;
    const api = installApi({ 'recording.getSetup': () => setup });
    await mount();
    await screen.findByRole('button', { name: 'Add API key' });
    const asked = api.named('recording.getSetup').length;
    // The key was saved in Settings (another window, or the pill): no reload, no restart.
    setup = readySetup;
    api.emit('transcription.statusChanged', { ready: true, liveEnabled: true, engine: 'Groq' });
    expect(await screen.findByRole('button', { name: 'Record' })).toBeEnabled();
    expect(api.named('recording.getSetup').length).toBe(asked + 1);
    expect(screen.queryByTestId('setup-checklist')).toBeNull();
  });

  const recordingState = {
    ...idleState,
    phase: 'Recording',
    isRecording: true,
    isTicking: true,
    meetingId: 'm1',
    title: 'Weekly',
    recordedAtMs: 1,
  };

  it('says captions come a few seconds late on the empty canvas', async () => {
    installApi({
      'transcription.getStatus': () => ({ ready: true, liveEnabled: true, engine: 'Groq' }),
      'recording.getState': () => ({ ...recordingState, liveText: '' }),
    });
    await mount();
    expect(await screen.findByTestId('canvas-empty')).toHaveTextContent(
      'Captions appear here a few seconds after people speak.',
    );
  });

  it('says captions come as people speak with an engine that streams', async () => {
    installApi({
      'transcription.getStatus': () => ({ ready: true, liveEnabled: true, engine: 'Deepgram' }),
      'recording.getState': () => ({ ...recordingState, liveText: '' }),
    });
    await mount();
    const empty = await screen.findByTestId('canvas-empty');
    expect(empty).toHaveTextContent('Captions appear here as people speak.');
    expect(empty).not.toHaveTextContent('a few seconds');
  });

  it('shows why the live captions stopped while the take goes on, and says the audio is kept', async () => {
    const reason = 'Groq did not accept your API key. Check it in Settings.';
    const api = installApi({
      'transcription.getStatus': () => ({ ready: true, liveEnabled: true, engine: 'Groq' }),
      'recording.getState': () => ({ ...recordingState, liveText: '' }),
    });
    await mount();
    await screen.findByTestId('live-canvas');
    expect(screen.queryByTestId('live-notice')).toBeNull();
    api.emit('recording.state', {
      ...recordingState,
      liveNotice: { key: 'Ui_CloudLiveStopped', args: [reason], severity: 'warning' },
    });
    const notice = await screen.findByTestId('live-notice');
    expect(notice).toHaveTextContent('Live captions stopped');
    expect(notice).toHaveTextContent(
      `${reason} The recording continues, and you can transcribe it after you stop.`,
    );
    // The empty canvas no longer promises captions.
    expect(screen.getByTestId('canvas-empty')).toHaveTextContent('Live captions stopped');
    expect(screen.getByTestId('canvas-empty')).not.toHaveTextContent('Captions appear here');
    // Announced politely, never as an alert, and the take's controls stay as they were.
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
});

describe('RecordRoute status bars', () => {
  it('shows the start refusal as an error bar by its typed severity', async () => {
    installApi({
      'recording.start': () => ({
        started: false,
        reason: 'failed',
        message: { key: 'Error_StartRecording', args: ['disk full'], severity: 'error' },
      }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Record' }));
    const bar = await screen.findByRole('alert');
    expect(bar).toHaveTextContent('Something went wrong');
    expect(bar).toHaveTextContent('disk full');
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('does not treat text that starts with Error as an error when the severity is info', async () => {
    const api = installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    api.emit('recording.state', {
      ...idleState,
      status: [{ key: 'Error_ImportAudio', args: ['only a note'], severity: 'info' }],
    });
    expect(await screen.findByText(/only a note/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the idle column shows the soft warning after a take, as a caption', async () => {
    const api = installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    api.emit('recording.state', {
      ...idleState,
      status: [
        { key: 'Status_Done', args: [], severity: 'info' },
        { key: 'Warning_MicrophoneLost', args: [], severity: 'warning' },
      ],
    });
    expect(await screen.findByText(/The microphone stopped working/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error bar during a session too, with the whole status', async () => {
    const api = installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    api.emit('recording.state', {
      ...idleState,
      phase: 'Processing',
      isProcessing: true,
      status: [
        { key: 'Error_OutputCaptureFailed', args: ['gone'], severity: 'error' },
        { key: 'Status_Transcribing', args: [], severity: 'info' },
      ],
    });
    const bar = await screen.findByRole('alert');
    expect(bar).toHaveTextContent('Something went wrong');
    expect(bar).toHaveTextContent('Transcribing audio...');
  });
});

describe('RecordRoute result card', () => {
  const saved = { ...idleState, lastMeeting: { id: 'm-9', title: 'Weekly sync' } };

  it('opens the Summary tab when the meeting has a summary', async () => {
    const api = installApi({
      'recording.getState': () => ({ ...saved, liveText: 'Hello there' }),
      'library.getMeeting': () => ({ record: { summary: 'A summary' } }),
    });
    await mount();
    const card = await screen.findByTestId('result-card');
    expect(card).toHaveTextContent('Weekly sync');
    expect(screen.getByTestId('saved-transcript')).toHaveTextContent('Hello there');
    await userEvent.click(within(card).getByRole('button', { name: 'Open' }));
    const opened = () =>
      api
        .named('workspace.dispatch')
        .filter(
          (c) =>
            JSON.stringify(c.input).includes('Session') ||
            JSON.stringify(c.input).includes('selectMeeting'),
        );
    await waitFor(() => {
      expect(opened()).toHaveLength(2);
    });
    expect(opened().map((call) => call.input)).toEqual([
      { action: { type: 'selectMeeting', id: 'm-9' } },
      { action: { type: 'openSession', tab: 'Summary' } },
    ]);
  });

  it('opens the Transcript tab when there is no summary', async () => {
    const api = installApi({
      'recording.getState': () => ({ ...saved, liveText: '' }),
      'library.getMeeting': () => ({ record: { summary: null } }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(api.named('workspace.dispatch').length).toBeGreaterThanOrEqual(3);
    });
    expect(api.named('workspace.dispatch').at(-1)?.input).toEqual({
      action: { type: 'openSession', tab: 'Transcript' },
    });
  });

  it('clears when the workspace reports the meeting deleted', async () => {
    const api = installApi({ 'recording.getState': () => ({ ...saved, liveText: '' }) });
    await mount();
    await screen.findByTestId('result-card');
    api.emit('workspace.meetingDeleted', { id: 'm-9' });
    await waitFor(() => {
      expect(screen.queryByTestId('result-card')).toBeNull();
    });
  });
});

describe('RecordRoute import', () => {
  it('picks a file, then imports it into the chosen destination', async () => {
    const api = installApi({
      'audio.import.pickFile': () => ({ path: 'C:\\in\\call.mp3', recordedAtMs: 5 }),
      'recording.import': () => ({ started: true, meetingId: 'm2' }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Import audio' }));
    await waitFor(() => {
      expect(api.named('recording.import')).toHaveLength(1);
    });
    expect(api.named('recording.import')[0]?.input).toMatchObject({
      projectId: null,
      path: 'C:\\in\\call.mp3',
    });
  });

  it('stays silent when the picker is cancelled and shows a refusal otherwise', async () => {
    let picked: unknown = null;
    installApi({
      'audio.import.pickFile': () => picked,
      'recording.import': () => ({
        started: false,
        reason: 'failed',
        message: { key: 'Error_ImportAudio', args: ['bad file'], severity: 'error' },
      }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Import audio' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Import audio' })).toBeEnabled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    picked = { path: 'C:\\in\\x.wav', recordedAtMs: 1 };
    await userEvent.click(screen.getByRole('button', { name: 'Import audio' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad file');
  });
});

describe('RecordRoute import from YouTube', () => {
  const LINK = 'https://youtu.be/dQw4w9WgXcQ?si=abc';
  const NORMAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('sits next to Import audio and is disabled with it while a take starts', async () => {
    installApi({ 'recording.start': () => new Promise(() => undefined) });
    await mount();
    const youtube = await screen.findByRole('button', { name: 'From YouTube' });
    expect(youtube).toHaveAttribute('data-testid', 'BtnImportYouTube');
    expect(within(screen.getByTestId('record-hero')).getByTestId('BtnImportYouTube')).toBe(youtube);
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'From YouTube' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Import audio' })).toBeDisabled();
  });

  it('is hidden with Import audio when the setup is not ready', async () => {
    installApi({ 'recording.getSetup': () => needsSetup });
    await mount();
    await screen.findByTestId('BtnSetUpToRecord');
    expect(screen.queryByTestId('BtnImportYouTube')).toBeNull();
  });

  it('asks for a link, holds the import until it is a YouTube video, then imports the normal form', async () => {
    const api = installApi({ 'recording.importUrl': () => ({ started: true, meetingId: 'm3' }) });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'From YouTube' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from YouTube' });
    const input = within(dialog).getByRole('textbox', { name: 'Video link' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    const submit = within(dialog).getByRole('button', { name: 'Import' });
    expect(submit).toBeDisabled();

    await userEvent.type(input, 'https://vimeo.com/1');
    expect(submit).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    expect(within(dialog).getByText("That isn't a YouTube video link.")).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby') ?? '').not.toBe('');
    expect(api.named('recording.importUrl')).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste(LINK);
    expect(submit).toBeEnabled();
    expect(within(dialog).queryByText("That isn't a YouTube video link.")).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.named('recording.importUrl')).toHaveLength(1);
    });
    expect(api.named('recording.importUrl')[0]?.input).toMatchObject({
      projectId: null,
      url: NORMAL,
    });
    expect(String(api.named('recording.importUrl')[0]?.input.title)).not.toBe('');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('closes on Escape without importing', async () => {
    const api = installApi({ 'recording.importUrl': () => ({ started: true, meetingId: 'm3' }) });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'From YouTube' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from YouTube' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Video link' }), NORMAL);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.named('recording.importUrl')).toHaveLength(0);
  });

  it('offers Cancel while the audio downloads and cancels the import', async () => {
    const api = installApi({
      'recording.importUrl': () => new Promise(() => undefined),
      'recording.cancelProcessing': () => ({ cancelled: true }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'From YouTube' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from YouTube' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Video link' }), NORMAL);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(api.named('recording.importUrl')).toHaveLength(1);
    });
    api.emit('recording.state', {
      ...idleState,
      phase: 'Preparing',
      status: [{ key: 'Ui_StatusDownloadingYouTube', args: [], severity: 'info' }],
    });
    expect(await screen.findByTestId('recording-status')).toHaveTextContent(
      'Downloading audio from YouTube…',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel transcription or summary' }));
    expect(api.named('recording.cancelProcessing')[0]?.input).toEqual({ meetingId: null });
  });

  it('shows the download status from main and a refusal as an error', async () => {
    const api = installApi({
      'recording.getState': () => ({
        ...idleState,
        status: [{ key: 'Ui_StatusDownloadingYouTube', args: [], severity: 'info' }],
        liveText: '',
      }),
      'recording.importUrl': () => ({
        started: false,
        reason: 'failed',
        message: { key: 'Ui_ErrorYouTubeDownload', args: ['private video'], severity: 'error' },
      }),
    });
    await mount();
    expect(await screen.findByTestId('status-text')).toHaveTextContent(
      'Downloading audio from YouTube…',
    );
    api.emit('recording.state', idleState);
    await userEvent.click(await screen.findByRole('button', { name: 'From YouTube' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from YouTube' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Video link' }), NORMAL);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't download the video's audio: private video",
    );
  });
});

describe('RecordRoute take notes request', () => {
  it('starts a blank recording when the request is pending and the page is idle', async () => {
    const api = installApi({
      'workspace.dispatch': () => ({
        state: {},
        takeNotes: { pending: true },
      }),
    });
    await mount();
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
  });
});

describe('RecordRoute processing', () => {
  const processing = {
    ...idleState,
    phase: 'Processing' as const,
    isProcessing: true,
    status: [{ key: 'Status_Transcribing', args: [], severity: 'info' as const }],
  };

  it('shows the status in a polite live region, an indeterminate bar and an enabled Cancel', async () => {
    const api = installApi({
      'recording.getState': () => ({ ...processing, liveText: '' }),
      'recording.cancelProcessing': () => ({ cancelled: true }),
    });
    await mount();
    const status = await screen.findByTestId('recording-status');
    expect(status).toHaveTextContent('Transcribing audio...');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel transcription or summary' });
    expect(cancel).toBeEnabled();
    expect(cancel).toHaveTextContent('Cancel');
    await userEvent.click(cancel);
    expect(api.named('recording.cancelProcessing')[0]?.input).toEqual({ meetingId: null });
  });

  it('a quiet Cancel summary appears on the result card only while the summary runs', async () => {
    const api = installApi({
      'recording.getState': () => ({
        ...idleState,
        lastMeeting: { id: 'm-9', title: 'Weekly sync' },
        status: [{ key: 'Status_GeneratingSummary', args: [], severity: 'info' }],
        liveText: '',
      }),
      'recording.cancelProcessing': () => ({ cancelled: true }),
    });
    await mount();
    const card = await screen.findByTestId('result-card');
    await userEvent.click(within(card).getByRole('button', { name: 'Cancel summary' }));
    expect(api.named('recording.cancelProcessing')[0]?.input).toEqual({ meetingId: 'm-9' });
    expect(screen.queryByTestId('BtnCancelProcessing')).toBeNull();
  });

  it('shows no Cancel summary once the summary is done', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        lastMeeting: { id: 'm-9', title: 'Weekly sync' },
        status: [{ key: 'Status_Done', args: [], severity: 'info' }],
        liveText: '',
      }),
    });
    await mount();
    await screen.findByTestId('result-card');
    expect(screen.queryByRole('button', { name: 'Cancel summary' })).toBeNull();
  });

  it('a failed first save offers Try saving again, which runs retryProcessing', async () => {
    const api = installApi({
      'recording.getState': () => ({
        ...idleState,
        canRetry: true,
        status: [{ key: 'Error_ProcessRecording', args: ['disk full'], severity: 'error' }],
        liveText: '',
      }),
      'recording.retryProcessing': () => ({ started: true }),
    });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Try saving again' }));
    expect(api.named('recording.retryProcessing')).toHaveLength(1);
  });

  it('offers no retry when nothing can be retried', async () => {
    installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    expect(screen.queryByRole('button', { name: 'Try saving again' })).toBeNull();
  });
});

describe('RecordRoute live ask', () => {
  const recording = {
    ...idleState,
    phase: 'Recording' as const,
    isRecording: true,
    title: 'Live take',
  };
  const answerOf = (extra: Record<string, unknown>) => ({
    isAnswering: false,
    text: '',
    error: null,
    usedWeb: false,
    canUseWebSearch: true,
    ...extra,
  });

  it('shows the dock under the transcript and the answer card beside it', async () => {
    installApi({ 'recording.getState': () => ({ ...recording, liveText: '' }) });
    await mount();
    const box = await screen.findByRole('textbox', { name: 'Type a question' });
    expect(box).toHaveAttribute('id', 'TxtLiveAsk');
    expect(box).toHaveAttribute('placeholder', 'Type a question, then press Ctrl+Enter');
    expect(screen.queryByTestId('answer-card')).toBeNull();
    act(() => {
      applyAnswer(answerOf({ text: 'Because of the budget.', usedWeb: true }));
    });
    const card = screen.getByTestId('answer-card');
    expect(within(card).getByRole('heading', { name: 'Answer' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Because of the budget.');
    expect(card).toHaveTextContent('Searched the web');
  });

  it('has no dock outside a recording and no armed question controls', async () => {
    installApi();
    await mount();
    await screen.findByRole('button', { name: 'Record' });
    expect(screen.queryByRole('textbox', { name: 'Type a question' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss the detected question' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Answer the detected question' })).toBeNull();
  });
});

describe('Start meeting in this project (/record?project=<id>&start=1)', () => {
  const start = (id: string) => `/record?project=${id}&start=1`;

  it('selects the project, starts the take there, and replaces the address before it does', async () => {
    const api = installApi();
    const router = await mount(start(P_ALPHA));
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
    expect(api.named('recording.start')[0]?.input).toMatchObject({ projectId: P_ALPHA });
    expect(router.state.location.search).toEqual({});
    expect(router.state.location.pathname).toBe('/record');
  });

  it('does not start again when the page draws again, or comes back to', async () => {
    const api = installApi();
    await mount(start(P_ALPHA));
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
    // The take ends and the page returns to idle: nothing in the address asks for another one.
    api.emit('recording.state', {
      ...idleState,
      phase: 'Recording',
      isRecording: true,
      title: 'x',
    });
    api.emit('recording.state', idleState);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.named('recording.start')).toHaveLength(1);
  });

  it('keeps the chosen project in the destination list after it starts', async () => {
    const api = installApi();
    await mount(start(P_BETA));
    await waitFor(() => {
      expect(api.named('recording.start')).toHaveLength(1);
    });
    expect(api.named('recording.start')[0]?.input).toMatchObject({ projectId: P_BETA });
  });

  it('falls back to No project for an id that is gone, says so, and starts nothing', async () => {
    const api = installApi();
    await mount(start('00000000-0000-4000-8000-0000000000ff'));
    expect(
      await screen.findByText('That project no longer exists. Choose where to save this meeting.'),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.named('recording.start')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Save to' })).toHaveTextContent('No project');
  });

  it('does not start a second take while one is recording, and says where it is saving', async () => {
    const api = installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Recording',
        isRecording: true,
        title: 'Live take',
        liveText: '',
      }),
    });
    await mount(start(P_ALPHA));
    expect(await screen.findByText('A meeting is already recording')).toBeInTheDocument();
    // Once in the toast, once in the line under the recording bar.
    expect(screen.getAllByText('Saving to No project')).toHaveLength(2);
    expect(api.named('recording.start')).toHaveLength(0);
    // The active take keeps its destination: the line under the bar still says No project.
    expect(screen.getByTestId('take-destination')).toHaveTextContent('Saving to No project');
  });

  it('shows the destination of the take under way as a quiet line', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Recording',
        isRecording: true,
        title: 'Live take',
        liveText: '',
      }),
    });
    await mount();
    expect(await screen.findByTestId('take-destination')).toHaveTextContent('Saving to No project');
  });

  it('shows the project of a take started elsewhere, as the recording state reports it', async () => {
    installApi({
      'recording.getState': () => ({
        ...idleState,
        phase: 'Recording',
        isRecording: true,
        projectId: P_ALPHA,
        title: 'Tray take',
        liveText: '',
      }),
    });
    await mount();
    expect(await screen.findByTestId('take-destination')).toHaveTextContent('Saving to Alpha');
  });

  it('a page opened without parameters starts nothing', async () => {
    const api = installApi();
    await mount('/record');
    await screen.findByRole('button', { name: 'Record' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.named('recording.start')).toHaveLength(0);
  });
});
