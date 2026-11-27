import { describe, expect, it } from 'vitest';
import type { LineSource } from '../transcription/line-source';
import { extractCommittedBody } from '../transcription/committed-line';
import { formatHeader, formatLine } from '../transcription/stamp-format';
import {
  CURSOR_TYPING_MODIFIER_RETRY_MS,
  CURSOR_TYPING_PAUSED_RETRY_MS,
  CursorTyper,
  type CursorTypingSource,
  type CursorTypingState,
  type CursorTypingTimers,
} from './cursor-typer';
import type { ForegroundTarget, TextInjectorPort, TypeTextResult } from './text-injector';

const NOTEPAD: ForegroundTarget = {
  windowHandle: 1001,
  focusHandle: 1002,
  processId: 4242,
  processName: 'notepad.exe',
  isOwnProcess: false,
  menuOpen: false,
  modifiersHeld: false,
  blocked: false,
};

const CHROME: ForegroundTarget = {
  ...NOTEPAD,
  windowHandle: 2001,
  focusHandle: 2002,
  processId: 5151,
  processName: 'chrome.exe',
};

const VOZELLA: ForegroundTarget = {
  ...NOTEPAD,
  windowHandle: 3001,
  focusHandle: 3002,
  processName: 'Vozella.exe',
  isOwnProcess: true,
};

/** Core cannot import the platform fake, so this stub mirrors it. */
class StubInjector implements TextInjectorPort {
  readonly typed: string[] = [];
  target: ForegroundTarget | null = NOTEPAD;
  respond: ((text: string) => TypeTextResult) | null = null;

  foregroundTarget(): ForegroundTarget | null {
    return this.target;
  }

  typeText(text: string): TypeTextResult {
    this.typed.push(text);
    if (this.respond) return this.respond(text);
    return { sent: text.length * 2, expected: text.length * 2 };
  }
}

interface Delayed {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** Nothing runs until the test says so: ticks with `flush`, retries with `elapse`. */
class ManualTimers implements CursorTypingTimers {
  private ticks: (() => void)[] = [];
  private delayed: Delayed[] = [];

  schedule(run: () => void): void {
    this.ticks.push(run);
  }

  after(ms: number, run: () => void): () => void {
    const entry: Delayed = { ms, run, cancelled: false };
    this.delayed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  flush(): void {
    while (this.ticks.length > 0) this.ticks.shift()?.();
  }

  /** The delays still waiting to fire. */
  pending(): number[] {
    return this.delayed.filter((entry) => !entry.cancelled).map((entry) => entry.ms);
  }

  /** Fires every retry waiting now, then the ticks they scheduled. */
  elapse(): void {
    const due = this.delayed.filter((entry) => !entry.cancelled);
    this.delayed = [];
    for (const entry of due) entry.run();
    this.flush();
  }
}

const HEADER = formatHeader(Date.UTC(2026, 10, 26, 10, 0));

/** A stamped line one second long at second `index`. */
const line = (index: number, text: string): string =>
  formatLine(index * 1000, index * 1000 + 900, text);

const transcript = (...lines: string[]): string => [HEADER, ...lines].join('\n');

function setup(sources: Record<string, LineSource> = {}) {
  const injector = new StubInjector();
  const timers = new ManualTimers();
  const classify = (committed: string): LineSource =>
    sources[extractCommittedBody(committed)] ?? 'others';
  const typer = new CursorTyper({ injector, classify, timers });
  const states: CursorTypingState[] = [];
  typer.onState((state) => states.push(state));
  const lines: string[] = [];
  /** Appends lines to the committed transcript and delivers it like a live update. */
  const say = (...texts: string[]): void => {
    for (const text of texts) lines.push(line(lines.length, text));
    typer.committed(transcript(...lines));
    timers.flush();
  };
  const arm = (source: CursorTypingSource = 'others') => typer.arm(source);
  return { injector, timers, typer, states, say, arm };
}

describe('CursorTyper arming', () => {
  it('types only the lines committed after arming', () => {
    const { injector, say, arm } = setup();
    say('before one', 'before two');
    expect(arm()).toEqual({ ok: true });
    say('after one');
    expect(injector.typed).toEqual(['after one']);
  });

  it('counts a live update that was not processed yet as already committed when arming', () => {
    const { injector, timers, typer, arm } = setup();
    typer.committed(transcript(line(0, 'still pending')));
    arm();
    timers.flush();
    expect(injector.typed).toEqual([]);
  });

  it.each([
    ['no-target', null],
    ['own-window', VOZELLA],
    ['blocked', { ...NOTEPAD, blocked: true }],
  ] as const)('refuses with %s and stays off', (reason, target) => {
    const { injector, typer, states, say, arm } = setup();
    injector.target = target;
    expect(arm()).toEqual({ ok: false, reason });
    expect(typer.state()).toEqual({ status: 'off' });
    expect(states).toEqual([]);
    injector.target = NOTEPAD;
    say('not typed');
    expect(injector.typed).toEqual([]);
  });

  it('reports the armed target and source', () => {
    const { typer, arm } = setup();
    arm('all');
    expect(typer.state()).toEqual({
      status: 'armed',
      source: 'all',
      processName: 'notepad.exe',
      warning: null,
    });
  });

  it('re-arms on the new target and drops what the old arming had queued', () => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.target = CHROME;
    say('queued for notepad');
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'focus-changed' });
    expect(arm()).toEqual({ ok: true });
    expect(timers.pending()).toEqual([]);
    expect(typer.state()).toMatchObject({ status: 'armed', processName: 'chrome.exe' });
    say('for chrome', 'second');
    expect(injector.typed).toEqual(['for chrome', ' second']);
  });

  it('keeps the current arming when a re-arm is refused', () => {
    const { injector, typer, arm } = setup();
    arm();
    injector.target = VOZELLA;
    expect(arm()).toEqual({ ok: false, reason: 'own-window' });
    expect(typer.state()).toMatchObject({ status: 'armed', processName: 'notepad.exe' });
  });
});

describe('CursorTyper lines', () => {
  it('types only the other participants in others mode', () => {
    const { injector, say, arm } = setup({ mine: 'self' });
    arm('others');
    say('theirs', 'mine', 'theirs again');
    expect(injector.typed).toEqual(['theirs', ' theirs again']);
  });

  it('types every line in all mode', () => {
    const { injector, say, arm } = setup({ mine: 'self', unclear: 'unknown' });
    arm('all');
    say('theirs', 'mine', 'unclear');
    expect(injector.typed).toEqual(['theirs', ' mine', ' unclear']);
  });

  it('types one line per call, the first without a leading space and the rest after one', () => {
    const { injector, say, arm } = setup();
    arm();
    say('one');
    say('two', 'three');
    expect(injector.typed).toEqual(['one', ' two', ' three']);
  });

  it('starts a new arming without a leading space', () => {
    const { injector, typer, say, arm } = setup();
    arm();
    say('one');
    typer.disarm();
    arm();
    say('two');
    expect(injector.typed).toEqual(['one', 'two']);
  });

  it('skips headers and empty bodies, and types the body without stamp or speaker label', () => {
    const { injector, timers, typer, arm } = setup();
    // Armed before the take wrote anything: its opening header arrives after arming.
    arm('all');
    typer.committed(
      [
        HEADER,
        formatLine(0, 900, 'labelled', 2),
        '',
        line(1, ''),
        'Ended 2026-11-26 10:30',
        line(2, 'next'),
      ].join('\n'),
    );
    timers.flush();
    expect(injector.typed).toEqual(['labelled', ' next']);
  });

  it('never types a tab, a control character or doubled spaces', () => {
    const { injector, say, arm } = setup();
    arm();
    say('a\tb   c\u000bd');
    expect(injector.typed).toEqual(['a b c d']);
  });
});

describe('CursorTyper guard', () => {
  it.each([
    ['modifiers held', { ...NOTEPAD, modifiersHeld: true }],
    ['a menu open', { ...NOTEPAD, menuOpen: true }],
  ])('waits while %s and types once released', (_label, target) => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.target = target;
    say('wait for me');
    expect(injector.typed).toEqual([]);
    expect(timers.pending()).toEqual([CURSOR_TYPING_MODIFIER_RETRY_MS]);
    expect(typer.state()).toMatchObject({ status: 'armed' });
    timers.elapse();
    expect(injector.typed).toEqual([]);
    injector.target = NOTEPAD;
    timers.elapse();
    expect(injector.typed).toEqual(['wait for me']);
    expect(timers.pending()).toEqual([]);
  });

  it('pauses on a focus change, keeps the queue and resumes in order', () => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.target = CHROME;
    say('one');
    say('two');
    expect(injector.typed).toEqual([]);
    expect(typer.state()).toEqual({
      status: 'paused',
      source: 'others',
      processName: 'notepad.exe',
      reason: 'focus-changed',
      warning: null,
    });
    expect(timers.pending()).toEqual([CURSOR_TYPING_PAUSED_RETRY_MS]);
    timers.elapse();
    expect(injector.typed).toEqual([]);
    injector.target = NOTEPAD;
    timers.elapse();
    expect(injector.typed).toEqual(['one', ' two']);
    expect(typer.state()).toMatchObject({ status: 'armed' });
  });

  it('pauses when the focused control inside the window changes', () => {
    const { injector, typer, say, arm } = setup();
    arm();
    injector.target = { ...NOTEPAD, focusHandle: 9999 };
    say('one');
    expect(injector.typed).toEqual([]);
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'focus-changed' });
  });

  it('types when either focus handle is unknown and the window is the same', () => {
    const { injector, say, arm } = setup();
    arm();
    injector.target = { ...NOTEPAD, focusHandle: null };
    say('one');
    expect(injector.typed).toEqual(['one']);
  });

  it('pauses when no window is in the foreground', () => {
    const { injector, typer, say, arm } = setup();
    arm();
    injector.target = null;
    say('one');
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'focus-changed' });
  });

  it('pauses with own-window when Vozella takes the foreground', () => {
    const { injector, typer, say, arm } = setup();
    arm();
    injector.target = VOZELLA;
    say('one');
    expect(injector.typed).toEqual([]);
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'own-window' });
  });

  it('pauses while the target is blocked and resumes when it is not', () => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.target = { ...NOTEPAD, blocked: true };
    say('one');
    expect(injector.typed).toEqual([]);
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'blocked' });
    expect(timers.pending()).toEqual([CURSOR_TYPING_PAUSED_RETRY_MS]);
    injector.target = NOTEPAD;
    timers.elapse();
    expect(injector.typed).toEqual(['one']);
    expect(typer.state()).toMatchObject({ status: 'armed' });
  });

  it('drops a cut-off line, pauses as interrupted and types the next line on the next attempt', () => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.respond = (text) => ({ sent: 3, expected: text.length * 2 });
    say('cut off', 'next');
    expect(injector.typed).toEqual(['cut off']);
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'interrupted' });
    expect(timers.pending()).toEqual([CURSOR_TYPING_PAUSED_RETRY_MS]);
    injector.respond = null;
    timers.elapse();
    expect(injector.typed).toEqual(['cut off', ' next']);
    expect(typer.state()).toMatchObject({ status: 'armed' });
  });

  it('treats a throwing injector as interrupted and continues', () => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.respond = () => {
      throw new Error('SendInput failed');
    };
    say('fails', 'next');
    expect(typer.state()).toMatchObject({ status: 'paused', reason: 'interrupted' });
    injector.respond = null;
    timers.elapse();
    // Nothing reached the field before the throw, so the next line still opens the arming.
    expect(injector.typed).toEqual(['fails', 'next']);
  });
});

describe('CursorTyper speaker warning', () => {
  it('skips an unknown speaker in others mode and warns', () => {
    const { injector, typer, say, arm } = setup({ who: 'unknown' });
    arm('others');
    say('who');
    expect(injector.typed).toEqual([]);
    expect(typer.state()).toEqual({
      status: 'armed',
      source: 'others',
      processName: 'notepad.exe',
      warning: 'speaker-unknown',
    });
  });

  it('clears the warning once a speaker is known again', () => {
    const { injector, typer, say, arm } = setup({ who: 'unknown' });
    arm('others');
    say('who', 'known');
    expect(injector.typed).toEqual(['known']);
    expect(typer.state()).toMatchObject({ warning: null });
  });
});

describe('CursorTyper disarm and reset', () => {
  it.each(['disarm', 'reset'] as const)('%s clears the queue and cancels the retry', (method) => {
    const { injector, timers, typer, say, arm } = setup();
    arm();
    injector.target = CHROME;
    say('queued');
    expect(timers.pending()).toEqual([CURSOR_TYPING_PAUSED_RETRY_MS]);
    typer[method]();
    expect(typer.state()).toEqual({ status: 'off' });
    expect(timers.pending()).toEqual([]);
    injector.target = NOTEPAD;
    timers.elapse();
    expect(injector.typed).toEqual([]);
  });

  it('types nothing while off', () => {
    const { injector, typer, say, arm } = setup();
    arm();
    typer.disarm();
    say('ignored');
    expect(injector.typed).toEqual([]);
  });

  it('reset forgets the take, so the next take is counted from its first line', () => {
    const { injector, timers, typer, arm } = setup();
    typer.committed(transcript(line(0, 'old one'), line(1, 'old two')));
    timers.flush();
    typer.reset();
    arm();
    typer.committed(transcript(line(0, 'new one')));
    timers.flush();
    expect(injector.typed).toEqual(['new one']);
  });
});

describe('CursorTyper state events', () => {
  it('notifies once per distinct state', () => {
    const { injector, timers, states, say, arm } = setup();
    arm();
    injector.target = CHROME;
    say('one');
    timers.elapse();
    timers.elapse();
    say('two');
    injector.target = NOTEPAD;
    timers.elapse();
    expect(states.map((state) => ('reason' in state ? state.reason : state.status))).toEqual([
      'armed',
      'focus-changed',
      'armed',
    ]);
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const { typer, arm } = setup();
    const seen: CursorTypingState[] = [];
    const unsubscribe = typer.onState((state) => seen.push(state));
    unsubscribe();
    arm();
    expect(seen).toEqual([]);
  });
});
