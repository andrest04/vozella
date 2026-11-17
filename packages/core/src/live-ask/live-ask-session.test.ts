import { describe, expect, it } from 'vitest';
import type { CancelSignal } from '../cancel';
import type { SummaryProviderKind } from '../library/settings';
import { LIVE_DIGEST_LABEL, LOCAL_CONTEXT_BUDGET } from '../chat/context-packer';
import { CancelledError } from '../summaries/provider';
import {
  LiveAskSession,
  type LiveAnswerState,
  type LiveAskDeps,
  type LiveAskResolution,
} from './live-ask-session';

interface Gate {
  promise: Promise<void>;
  open(): void;
}
const gate = (): Gate => {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

function setup(
  options: {
    kind?: SummaryProviderKind;
    chunks?: (cancel: CancelSignal, prompt: string) => AsyncIterable<string>;
    resolution?: LiveAskResolution;
    setupWired?: boolean;
    settingsGate?: Gate;
    committed?: string;
    context?: () => ReturnType<LiveAskDeps['sessionContext']>;
  } = {},
) {
  const published: LiveAnswerState[] = [];
  const prompts: string[] = [];
  const webFlags: boolean[] = [];
  let now = 0;
  const deps: LiveAskDeps = {
    loadSettings: async () => {
      await options.settingsGate?.promise;
      return { providerKind: options.kind ?? 'ClaudeCode', language: 'en' };
    },
    resolveProvider: async ({ webSearch }) => {
      webFlags.push(webSearch);
      return (
        options.resolution ?? {
          status: 'ready',
          provider: {
            streamPrompt: (prompt, cancel) => {
              prompts.push(prompt);
              return (
                options.chunks ??
                async function* () {
                  yield 'ok';
                }
              )(cancel, prompt);
            },
          },
        }
      );
    },
    committedText: () => options.committed ?? '[00:00.00-00:10.00] hello there',
    sessionContext: options.context ?? (() => ({ title: 'Math' })),
    publish: (s) => published.push(s),
    nowMs: () => now,
    formatFailure: (e) => `failed: ${(e as Error).message}`,
    setupWired: options.setupWired ?? false,
  };
  const session = new LiveAskSession(deps);
  return {
    session,
    published,
    prompts,
    webFlags,
    advance: (ms: number) => {
      now += ms;
    },
    last: () => published[published.length - 1],
  };
}

describe('LiveAskSession', () => {
  it('streams, publishes the trimmed final text and the prompt carries window and context', async () => {
    const t = setup({
      chunks: async function* () {
        yield '  Hello';
        yield ' world \n';
      },
    });
    await t.session.ask('  Why?  ');
    expect(t.last()).toMatchObject({ isAnswering: false, text: 'Hello world', error: null });
    expect(t.prompts[0]).toContain('Question:\nWhy?\n');
    expect(t.prompts[0]).toContain('hello there');
    expect(t.prompts[0]).toContain('Meeting: Math');
    expect(t.published[0]).toMatchObject({ isAnswering: true, text: '' });
  });

  it('publishes nothing until visible text, then trimStart first and at most every 80 ms', async () => {
    const t = setup({
      chunks: async function* () {
        for (const chunk of ['  ', '\n', ' Hi', ' there', ' you', ' all ']) {
          yield chunk;
        }
      },
    });
    await t.session.ask('q');
    const texts = t.published.map((s) => s.text);
    // First visible chunk publishes at once; the clock never advanced, so later chunks are held.
    expect(texts).toEqual(['', '', 'Hi', 'Hi there you all']);
  });

  it('a later chunk publishes once 80 ms passed', async () => {
    const t = setup({
      chunks: async function* () {
        yield 'a';
        yield 'b';
        t.advance(80);
        yield 'c';
      },
    });
    await t.session.ask('q');
    expect(t.published.map((s) => s.text)).toEqual(['', '', 'a', 'abc', 'abc']);
  });

  it('an empty answer reports RecordPage_LiveAnswerEmpty', async () => {
    const t = setup({
      chunks: async function* () {
        yield '  \n';
      },
    });
    await t.session.ask('q');
    expect(t.last()).toMatchObject({
      isAnswering: false,
      text: '',
      error: { key: 'RecordPage_LiveAnswerEmpty' },
    });
  });

  it('a provider failure shows the formatted CLI message', async () => {
    const t = setup({
      chunks: async function* () {
        yield 'x';
        throw new Error('boom');
      },
    });
    await t.session.ask('q');
    expect(t.last()).toMatchObject({
      isAnswering: false,
      error: { key: null, text: 'failed: boom' },
    });
  });

  it('a cancellation error is silent', async () => {
    const t = setup({
      chunks: async function* () {
        throw new CancelledError();
        yield 'never';
      },
    });
    await t.session.ask('q');
    expect(t.last()?.error).toBeNull();
  });

  it.each([
    [false, 'Ui_LiveAnswerNoProvider'],
    [true, 'Status_SetupCancelled'],
  ])('unresolved provider with setupWired=%s gives %s', async (setupWired, key) => {
    const t = setup({ resolution: { status: 'unresolved' }, setupWired });
    await t.session.ask('q');
    expect(t.last()).toMatchObject({ isAnswering: false, error: { key } });
  });

  it('web is used only for a CLI provider with the toggle on, and the toggle survives reset', async () => {
    const cli = setup({ kind: 'Codex' });
    cli.session.setForceWebSearch(true);
    await cli.session.ask('q');
    expect(cli.webFlags).toEqual([true]);
    expect(cli.prompts[0]).toContain('web search');
    expect(cli.last()).toMatchObject({ usedWeb: true, canUseWebSearch: true });
    cli.session.reset();
    expect(cli.session.forceWebSearch).toBe(true);
    expect(cli.last()).toMatchObject({ text: '', usedWeb: false });

    const local = setup({ kind: 'Local' });
    local.session.setForceWebSearch(true);
    await local.session.ask('q');
    expect(local.webFlags).toEqual([false]);
    expect(local.last()).toMatchObject({ usedWeb: false, canUseWebSearch: false });
  });

  it('a newer ask owns the state; the older answer never publishes', async () => {
    const t = setup({
      chunks: async function* (cancel, prompt) {
        if (prompt.includes('Question:\none\n')) {
          await new Promise<void>((resolve) => cancel.onCancel(resolve));
          yield 'OLD';
        } else {
          yield 'NEW';
        }
      },
    });
    const first = t.session.ask('one');
    await Promise.resolve();
    await Promise.resolve();
    await t.session.ask('two');
    await first;
    expect(t.last()).toMatchObject({ text: 'NEW', isAnswering: false });
    expect(t.published.some((s) => s.text.includes('OLD'))).toBe(false);
  });

  it('cancel during settings load ends answering and nothing else is published', async () => {
    const settingsGate = gate();
    const t = setup({ settingsGate });
    const run = t.session.ask('q');
    t.session.cancel();
    settingsGate.open();
    await run;
    expect(t.last()).toMatchObject({ isAnswering: false, text: '', error: null });
    expect(t.prompts).toHaveLength(0);
  });

  it('cancel aborts the provider signal mid-stream and keeps the state silent', async () => {
    let signal: CancelSignal | null = null;
    const hold = gate();
    const t = setup({
      chunks: async function* (cancel) {
        signal = cancel;
        yield 'partial';
        await hold.promise;
        yield ' more';
      },
    });
    const run = t.session.ask('q');
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    t.session.cancel();
    hold.open();
    await run;
    expect((signal as CancelSignal | null)?.cancelled).toBe(true);
    expect(t.last()).toMatchObject({ isAnswering: false });
    expect(t.last()?.error).toBeNull();
  });

  it('preset trims, blank is ignored', async () => {
    const t = setup();
    await t.session.askPreset('   ');
    expect(t.published).toHaveLength(0);
    await t.session.askPreset('  What did I miss?  ');
    expect(t.prompts[0]).toContain('Question:\nWhat did I miss?\n');
  });

  it('reset clears the answer and learns whether the provider can search', async () => {
    const t = setup({ kind: 'ClaudeCode' });
    await t.session.ask('q');
    t.session.reset();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(t.last()).toMatchObject({
      text: '',
      error: null,
      usedWeb: false,
      canUseWebSearch: true,
    });
  });
});

describe('LiveAskSession take context (live chat parity)', () => {
  const stampAt = (s: number): string => {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}.00`;
  };
  const at = (start: number, end: number, text: string): string =>
    `[${stampAt(start)}-${stampAt(end)}] ${text}`;
  const take = [
    at(0, 10, 'minute zero'),
    at(1000, 1010, 'minute five'),
    at(1190, 1200, 'tail'),
  ].join('\n');
  const context = {
    title: 'Planning',
    notes: 'Ask about the launch date',
    digest: '- Budget agreed (02:10)',
  };

  it('a typed ask carries the notes and the rolling digest next to the title', async () => {
    const t = setup({ committed: take, context: () => context });
    await t.session.ask('Why?');
    expect(t.prompts[0]).toContain('Meeting: Planning');
    expect(t.prompts[0]).toContain('Notes: Ask about the launch date');
    expect(t.prompts[0]).toContain(LIVE_DIGEST_LABEL);
    expect(t.prompts[0]).toContain('- Budget agreed (02:10)');
  });

  it('only a preset asks for the whole take', async () => {
    const typed = setup({ committed: take, context: () => context });
    await typed.session.ask('Why?');
    expect(typed.prompts[0]).not.toContain('cover the whole recording so far');
    const preset = setup({ committed: take, context: () => context });
    await preset.session.askPreset('What did I miss?');
    expect(preset.prompts[0]).toContain('cover the whole recording so far');
  });

  it('a typed ask still reads only the last 90 seconds', async () => {
    const t = setup({ committed: take, context: () => context });
    await t.session.ask('Why?');
    expect(t.prompts[0]).toContain('tail');
    expect(t.prompts[0]).not.toContain('minute five');
  });

  it('a preset with a digest reads the digest plus about 3 minutes', async () => {
    const wide = [at(0, 10, 'ancient'), at(1050, 1060, 'inside'), at(1190, 1200, 'tail')].join(
      '\n',
    );
    const t = setup({ committed: wide, context: () => context });
    await t.session.askPreset('What did I miss?');
    expect(t.prompts[0]).toContain('- Budget agreed (02:10)');
    expect(t.prompts[0]).toContain('inside');
    expect(t.prompts[0]).not.toContain('ancient');
  });

  it('a preset without a digest falls back to a wider window of about 10 minutes', async () => {
    const t = setup({
      committed: take,
      context: () => ({ title: 'Planning', notes: null, digest: null }),
    });
    await t.session.askPreset('What did I miss?');
    expect(t.prompts[0]).toContain('minute five');
    expect(t.prompts[0]).toContain('tail');
    expect(t.prompts[0]).not.toContain('minute zero');
    expect(t.prompts[0]).not.toContain(LIVE_DIGEST_LABEL);
  });

  it('the local engine keeps a wide preset window under the local budget', async () => {
    const long = Array.from({ length: 60 }, (_, i) =>
      at(i * 5, i * 5 + 5, `line ${i} ${'z'.repeat(200)}`),
    );
    const t = setup({
      kind: 'Local',
      committed: long.join('\n'),
      context: () => ({ title: 'Planning', digest: null }),
    });
    await t.session.askPreset('What did I miss?');
    const window = t.prompts[0]?.split('Transcript window:\n')[1] ?? '';
    expect(window.length).toBeLessThanOrEqual(LOCAL_CONTEXT_BUDGET.liveChars);
    expect(window.length).toBeGreaterThan(0);
  });
});
