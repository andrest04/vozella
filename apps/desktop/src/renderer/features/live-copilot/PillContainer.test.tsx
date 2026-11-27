// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/translate';
import { PillContainer } from './PillContainer';

type Listener = (payload: never) => void;

const pillState = (over: Record<string, unknown> = {}) => ({
  visible: true,
  expanded: false,
  edge: 'Right',
  vertical: true,
  animationsEnabled: true,
  opacity: 1,
  contentOpacity: 1,
  window: { width: 80, height: 256 },
  capsule: { x: 8, y: 8, width: 64, height: 240 },
  panel: null,
  ...over,
});

const recordingState = (over: Record<string, unknown> = {}) => ({
  phase: 'Recording',
  isRecording: true,
  isPaused: false,
  isProcessing: false,
  elapsedMs: 0,
  elapsedAsOfMs: Date.now(),
  isTicking: false,
  status: [],
  micLevel: 0,
  captureNotices: [],
  liveNotice: null,
  meetingId: 'm1',
  title: 't',
  recordedAtMs: null,
  highlightCount: 0,
  notes: '',
  canRetry: false,
  lastMeeting: null,
  liveText: '',
  ...over,
});

function install(
  options: {
    reduced?: boolean;
    pill?: Record<string, unknown>;
    rec?: Record<string, unknown>;
    highlight?: { marked: boolean; elapsedMs: number };
  } = {},
) {
  const listeners = new Map<string, Listener>();
  let current = pillState(options.pill);
  const invoke = vi.fn((name: string, input: unknown) => {
    switch (name) {
      case 'pill.ready':
        return Promise.resolve(current);
      case 'pill.setExpanded':
        current = { ...current, expanded: (input as { expanded: boolean }).expanded };
        return Promise.resolve(current);
      case 'recording.getState':
        return Promise.resolve(recordingState(options.rec));
      case 'recording.highlight':
        return Promise.resolve(options.highlight ?? { marked: true, elapsedMs: 12_340 });
      case 'i18n.getLocale':
        return Promise.resolve({ locale: 'en' });
      default:
        return Promise.resolve({ done: true });
    }
  });
  Object.defineProperty(window, 'vozella', {
    configurable: true,
    value: {
      invoke,
      on: (name: string, listener: Listener) => {
        listeners.set(name, listener);
        return () => {
          if (listeners.get(name) === listener) listeners.delete(name);
        };
      },
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: Boolean(options.reduced) && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  return {
    invoke,
    emit: (name: string, payload: unknown = {}) => {
      act(() => {
        listeners.get(name)?.(payload as never);
      });
    },
  };
}

async function mount(locale: Locale = 'en') {
  render(
    <I18nProvider initialLocale={locale}>
      <PillContainer />
    </I18nProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PillContainer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('tells main it is ready and draws the state main answers', async () => {
    const bridge = install();
    await mount();
    expect(bridge.invoke).toHaveBeenCalledWith('pill.ready', {});
    const capsule = screen.getByTestId('LiveCopilotCapsule');
    expect(capsule.style.left).toBe('8px');
    expect(capsule).toHaveAttribute('data-orientation', 'vertical');
  });

  it('draws 125:03 for 7,503,000 ms with unbounded minutes', async () => {
    install({ rec: { elapsedMs: 7_503_000 } });
    await mount();
    expect(screen.getByTestId('TxtLiveCopilotElapsed')).toHaveTextContent('125:03');
  });

  it('follows recording.state: paused swaps the glyph, the name and the tooltip', async () => {
    const bridge = install();
    await mount();
    expect(screen.getByRole('button', { name: en['LiveCopilot_Pause.AutomationProperties.Name'] }));
    bridge.emit('recording.state', recordingState({ isPaused: true, elapsedMs: 5000 }));
    expect(
      screen.getByRole('button', { name: en['LiveCopilot_Resume.AutomationProperties.Name'] }),
    );
    expect(screen.getByTestId('TxtLiveCopilotElapsed')).toHaveAttribute(
      'title',
      en.LiveCopilot_StatusPaused,
    );
    expect(screen.getByTestId('TxtLiveCopilotElapsed')).toHaveTextContent('00:05');
  });

  it('takes the names from the Spanish catalog too', async () => {
    install();
    await mount('es');
    expect(
      screen.getByRole('button', { name: es['LiveCopilot_Stop.AutomationProperties.Name'] }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: es['LiveCopilot_OpenApp.AutomationProperties.Name'] }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: es['LiveCopilot_Expand.AutomationProperties.Name'] }),
    ).toBeVisible();
  });

  it('feeds the level events to the bars', async () => {
    const bridge = install();
    vi.useRealTimers();
    await mount();
    bridge.emit('pill.state', pillState({ visible: false }));
    bridge.emit('audio.recording.level', { level: 100 });
    const heights = Array.from(document.querySelectorAll('[data-bar]')).map((b) =>
      Number.parseFloat((b as HTMLElement).style.height),
    );
    expect(heights[2]).toBe(24);
  });

  it('sends the four button actions and asks for the opposite panel state', async () => {
    const bridge = install();
    await mount();
    fireEvent.click(
      screen.getByRole('button', { name: en['LiveCopilot_OpenApp.AutomationProperties.Name'] }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: en['LiveCopilot_Pause.AutomationProperties.Name'] }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: en['LiveCopilot_Stop.AutomationProperties.Name'] }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: en['LiveCopilot_Expand.AutomationProperties.Name'] }),
    );
    expect(bridge.invoke).toHaveBeenCalledWith('pill.openApp', {});
    expect(bridge.invoke).toHaveBeenCalledWith('pill.togglePause', {});
    expect(bridge.invoke).toHaveBeenCalledWith('pill.stop', {});
    expect(bridge.invoke).toHaveBeenCalledWith('pill.setExpanded', { expanded: true });
    await act(async () => {
      await Promise.resolve();
    });
    // The answer of setExpanded is the new state: the chat button now collapses.
    expect(
      screen.getByRole('button', { name: en['LiveCopilot_Collapse.AutomationProperties.Name'] }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  describe('highlight', () => {
    const highlightName = en['LiveCopilot_Highlight.AutomationProperties.Name'];

    it('marks this moment through recording.highlight and says so for 2 s', async () => {
      const bridge = install();
      await mount();
      const button = screen.getByRole('button', { name: highlightName });
      fireEvent.click(button);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(bridge.invoke).toHaveBeenCalledWith('recording.highlight', {});
      expect(button).toHaveAttribute('data-marked', 'true');
      expect(screen.getByTestId('pill-highlight-status')).toHaveTextContent('Highlighted 00:12.34');
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(button).not.toHaveAttribute('data-marked');
      expect(screen.getByTestId('pill-highlight-status')).toBeEmptyDOMElement();
    });

    it('stays quiet when main did not mark anything', async () => {
      install({ highlight: { marked: false, elapsedMs: 0 } });
      await mount();
      fireEvent.click(screen.getByRole('button', { name: highlightName }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('pill-highlight-status')).toBeEmptyDOMElement();
    });

    it('is available while paused and disabled once the take stops', async () => {
      const bridge = install({ rec: { isPaused: true } });
      await mount();
      expect(screen.getByRole('button', { name: highlightName })).toBeEnabled();
      bridge.emit('recording.state', recordingState({ phase: 'Stopping', isRecording: false }));
      expect(screen.getByRole('button', { name: highlightName })).toBeDisabled();
    });

    it('names the button in Spanish', async () => {
      install();
      await mount('es');
      expect(
        screen.getByRole('button', { name: es['LiveCopilot_Highlight.AutomationProperties.Name'] }),
      ).toBeInTheDocument();
    });
  });

  it('applies the page opacity and the capsule opacity main pushes', async () => {
    const bridge = install();
    await mount();
    bridge.emit('pill.state', pillState({ opacity: 0.5, contentOpacity: 0.2 }));
    expect(screen.getByTestId('pill-root').style.opacity).toBe('0.5');
    expect(screen.getByTestId('LiveCopilotCapsule').style.opacity).toBe('0.2');
  });

  it('flips the layout when main pushes a horizontal state', async () => {
    const bridge = install();
    await mount();
    bridge.emit(
      'pill.state',
      pillState({
        edge: 'Top',
        vertical: false,
        window: { width: 288, height: 80 },
        capsule: { x: 8, y: 8, width: 272, height: 64 },
      }),
    );
    expect(screen.getByTestId('LiveCopilotCapsule')).toHaveAttribute(
      'data-orientation',
      'horizontal',
    );
  });

  describe('started hint', () => {
    it('shows the message for 2500 ms, away from the docked edge, with the pulse', async () => {
      const bridge = install();
      await mount();
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: true });
      expect(screen.getByRole('status')).toHaveTextContent(en.LiveCopilot_StartedMessage);
      expect(screen.getByRole('status')).toHaveAttribute('data-side', 'left');
      expect(screen.getByTestId('LiveCopilotCapsule')).toHaveAttribute('data-pulse');
      act(() => {
        vi.advanceTimersByTime(2499);
      });
      expect(screen.queryByRole('status')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('is cancelled by show false (hide or drag)', async () => {
      const bridge = install();
      await mount();
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Left', pulse: true });
      expect(screen.getByRole('status')).toHaveAttribute('data-side', 'right');
      bridge.emit('pill.hint', { show: false, durationMs: 2500, edge: 'Left', pulse: false });
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('a second hint restarts the 2500 ms window', async () => {
      const bridge = install();
      await mount();
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: true });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: true });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByRole('status')).not.toBeNull();
    });

    it('plays no pulse under reduced motion', async () => {
      const bridge = install({ reduced: true });
      await mount();
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: true });
      expect(screen.getByRole('status')).toBeVisible();
      expect(screen.getByTestId('LiveCopilotCapsule')).not.toHaveAttribute('data-pulse');
    });

    it('plays no pulse when the OS animations are off', async () => {
      const bridge = install({ pill: { animationsEnabled: false } });
      await mount();
      bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: true });
      expect(screen.getByTestId('LiveCopilotCapsule')).not.toHaveAttribute('data-pulse');
    });
  });
});

describe('PillContainer type at cursor', () => {
  const typing = (over: Record<string, unknown> = {}) => ({
    state: { status: 'off' },
    shortcut: { status: 'registered', accelerator: 'CommandOrControl+Alt+Space' },
    lastRefusal: null,
    refusalSeq: 0,
    ...over,
  });
  const armed = (warning: string | null = null) => ({
    status: 'armed',
    source: 'others',
    processName: 'chrome.exe',
    warning,
  });
  const paused = (reason: string) => ({
    status: 'paused',
    source: 'others',
    processName: 'chrome.exe',
    reason,
    warning: null,
  });
  const note = () => screen.queryByTestId('pill-cursor-typing-note');
  const announced = () => screen.getByTestId('pill-cursor-typing-status');
  const badge = () => screen.queryByTestId('pill-cursor-typing-badge');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows nothing while typing is off and no hint has run', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing());
    expect(badge()).toBeNull();
    expect(note()).toBeNull();
    expect(announced()).toHaveTextContent('');
  });

  it('marks the logo while armed, names the app briefly and announces it', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing({ state: armed() }));
    expect(badge()).toHaveAttribute('data-mode', 'armed');
    expect(badge()).toHaveAttribute('title', 'Typing into Chrome');
    expect(note()).toHaveTextContent('Typing into Chrome');
    expect(announced()).toHaveTextContent('Typing into Chrome');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(note()).toBeNull();
    expect(badge()).toHaveAttribute('data-mode', 'armed');
    expect(announced()).toHaveTextContent('Typing into Chrome');
  });

  it('says why typing paused, with a different mark than armed', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing({ state: armed() }));
    bridge.emit('cursorTyping.state', typing({ state: paused('focus-changed') }));
    expect(badge()).toHaveAttribute('data-mode', 'paused');
    expect(note()).toHaveTextContent('Paused: go back to Chrome to continue');
    bridge.emit('cursorTyping.state', typing({ state: paused('blocked') }));
    expect(note()).toHaveTextContent("Can't type into apps running as administrator");
    bridge.emit('cursorTyping.state', typing({ state: armed('speaker-unknown') }));
    expect(badge()).toHaveAttribute('data-mode', 'paused');
    expect(note()).toHaveTextContent("No microphone: can't tell who's speaking");
  });

  it('confirms a stop with a short note and drops the mark', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing({ state: armed() }));
    bridge.emit('cursorTyping.state', typing());
    expect(badge()).toBeNull();
    expect(note()).toHaveTextContent('Stopped typing');
  });

  it('answers a press that armed nothing', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing({ lastRefusal: 'own-window' }));
    expect(badge()).toBeNull();
    expect(note()).toHaveTextContent('Put your cursor in another app first');
    expect(announced()).toHaveTextContent('Put your cursor in another app first');
  });

  it('answers a repeated press with the same refusal again', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing({ lastRefusal: 'inactive', refusalSeq: 1 }));
    expect(note()).toHaveTextContent('Start a recording first');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(note()).toBeNull();
    bridge.emit('cursorTyping.state', typing({ lastRefusal: 'inactive', refusalSeq: 2 }));
    expect(note()).toHaveTextContent('Start a recording first');
  });

  it('names a shortcut another app holds', async () => {
    const bridge = install();
    await mount();
    bridge.emit(
      'cursorTyping.state',
      typing({ shortcut: { status: 'unavailable', accelerator: 'CommandOrControl+Alt+Space' } }),
    );
    expect(note()).toHaveTextContent('Another app uses Ctrl+Alt+Space');
  });

  it('teaches the shortcut once, after the started hint closes', async () => {
    const bridge = install();
    await mount();
    bridge.emit('cursorTyping.state', typing());
    bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: false });
    expect(note()).toBeNull();
    bridge.emit('pill.hint', { show: false, durationMs: 2500, edge: 'Right', pulse: false });
    expect(note()).toHaveTextContent('Ctrl+Alt+Space types at your cursor');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(note()).toBeNull();
    bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: false });
    bridge.emit('pill.hint', { show: false, durationMs: 2500, edge: 'Right', pulse: false });
    expect(note()).toBeNull();
  });

  it('keeps the started hint on top of a note', async () => {
    const bridge = install();
    await mount();
    bridge.emit('pill.hint', { show: true, durationMs: 2500, edge: 'Right', pulse: false });
    bridge.emit('cursorTyping.state', typing({ state: armed() }));
    expect(note()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(en.LiveCopilot_StartedMessage);
    expect(announced()).toHaveTextContent('Typing into Chrome');
  });

  it('speaks Spanish', async () => {
    const bridge = install();
    await mount('es');
    bridge.emit('cursorTyping.state', typing({ state: paused('focus-changed') }));
    expect(note()).toHaveTextContent('En pausa: vuelve a Chrome para continuar');
  });
});
