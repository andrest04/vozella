import { CancelSource, type CancelSignal } from '../cancel';
import {
  CLI_CONTEXT_BUDGET,
  LOCAL_CONTEXT_BUDGET,
  packLiveSession,
  type ContextBudget,
} from '../chat/context-packer';
import type { SummaryProviderKind } from '../library/settings';
import { isCancellation, type SummaryProvider } from '../summaries/provider';
import {
  DEFAULT_ANSWER_WINDOW_MS,
  OVERVIEW_WINDOW_NO_DIGEST_MS,
  OVERVIEW_WINDOW_WITH_DIGEST_MS,
  takeRecentWindow,
} from './answer-window';
import { buildLiveAnswerPrompt } from './prompt-builder';
import { takeTail } from './utf16';
import { shouldUseWeb, supportsWebSearch } from './web-policy';

/** At most one publish per this many ms once the first visible text went out. */
export const LIVE_ANSWER_FLUSH_MS = 80;

/** A catalog key, or ready text (a CLI failure already in the user's language). */
export interface LiveAnswerError {
  readonly key: string | null;
  readonly text: string;
}

export interface LiveAnswerState {
  readonly isAnswering: boolean;
  readonly text: string;
  readonly error: LiveAnswerError | null;
  readonly usedWeb: boolean;
  readonly canUseWebSearch: boolean;
}

export type LiveAskResolution =
  | { readonly status: 'ready'; readonly provider: Pick<SummaryProvider, 'streamPrompt'> }
  | { readonly status: 'unresolved' };

export interface LiveAskDeps {
  loadSettings(): Promise<{
    readonly providerKind: SummaryProviderKind;
    readonly language: string | null;
  }>;
  resolveProvider(request: {
    kind: SummaryProviderKind;
    webSearch: boolean;
  }): Promise<LiveAskResolution>;
  /** The committed transcript of the take so far. */
  committedText(): string;
  /** What the live chat packs besides the transcript: title, notes and the rolling digest. */
  sessionContext(): {
    readonly title: string | null;
    readonly notes?: string | null;
    readonly digest?: string | null;
  };
  publish(state: LiveAnswerState): void;
  nowMs(): number;
  formatFailure(error: unknown): string;
  /** True when the page can open the provider setup (the message then says it was cancelled). */
  readonly setupWired: boolean;
}

/** A typed ask reads the last minutes; a preset overview reads the digest and a wider window. */
export type LiveAskScope = 'recent' | 'overview';

/** Local llama has a small context; every other engine gets the large live budget. */
const budgetFor = (kind: SummaryProviderKind): ContextBudget =>
  kind === 'Local' ? LOCAL_CONTEXT_BUDGET : CLI_CONTEXT_BUDGET;

/** A typed ask of the take with the answer it got. */
export interface LiveAskExchange {
  readonly question: string;
  readonly answer: string;
}

/** The take keeps this many exchanges; the oldest go first. */
export const LIVE_ASK_HISTORY_MAX = 50;

const hasVisible = (text: string): boolean => text.trim() !== '';

const IDLE = { isAnswering: false, text: '', error: null, usedWeb: false } as const;

/**
 * One typed question at a time (spec 3.12). A newer ask, Stop, Discard or a new take bumps the
 * generation, so a stale answer never publishes and a cancelled one is silent.
 */
export class LiveAskSession {
  private generation = 0;
  private source: CancelSource | null = null;
  private forceWeb = false;
  private state: LiveAnswerState = { ...IDLE, canUseWebSearch: false };
  private asked: LiveAskExchange[] = [];

  constructor(private readonly deps: LiveAskDeps) {}

  get current(): LiveAnswerState {
    return this.state;
  }

  /** The toggle. It is not reset between takes (114). */
  setForceWebSearch(value: boolean): void {
    this.forceWeb = value;
  }

  /** The typed asks of this take that got an answer, oldest first. Stop keeps them; a new take clears them. */
  get exchanges(): readonly LiveAskExchange[] {
    return this.asked;
  }

  get forceWebSearch(): boolean {
    return this.forceWeb;
  }

  /** Item 116: the chips use the typed path with the prompt trimmed, over the whole take. */
  askPreset(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    return trimmed === '' ? Promise.resolve() : this.ask(trimmed, 'overview');
  }

  async ask(question: string, scope: LiveAskScope = 'recent'): Promise<void> {
    const text = question.trim();
    if (text === '') return;
    const generation = this.begin();
    const source = new CancelSource();
    this.source = source;
    this.set({ ...this.state, isAnswering: true, text: '', error: null, usedWeb: false });
    const stale = (): boolean => generation !== this.generation || source.cancelled;
    try {
      const settings = await this.deps.loadSettings();
      if (stale()) return;
      const supportsWeb = supportsWebSearch(settings.providerKind);
      this.set({ ...this.state, canUseWebSearch: supportsWeb });
      const useWeb = shouldUseWeb(supportsWeb, this.forceWeb);
      const resolution = await this.deps.resolveProvider({
        kind: settings.providerKind,
        webSearch: useWeb,
      });
      if (stale()) return;
      if (resolution.status !== 'ready') {
        const key = this.deps.setupWired ? 'Status_SetupCancelled' : 'Ui_LiveAnswerNoProvider';
        this.set({ ...this.state, isAnswering: false, error: { key, text: '' } });
        return;
      }
      const budget = budgetFor(settings.providerKind);
      const context = this.deps.sessionContext();
      const hasDigest = (context.digest ?? '').trim() !== '';
      const prompt = buildLiveAnswerPrompt(
        text,
        this.transcriptWindow(scope, hasDigest, budget),
        settings.language,
        packLiveSession(context, budget),
        useWeb,
        scope === 'overview',
      );
      const buffer = await this.stream(resolution.provider, prompt, source.signal, stale);
      if (buffer === null) return;
      const answer = buffer.trim();
      if (answer === '') {
        this.set({
          ...this.state,
          isAnswering: false,
          text: '',
          error: { key: 'RecordPage_LiveAnswerEmpty', text: '' },
        });
        return;
      }
      this.set({ ...this.state, isAnswering: false, text: answer, error: null, usedWeb: useWeb });
      // The chips are fixed prompts, not the user's questions: only typed asks are kept.
      if (scope === 'recent') this.remember({ question: text, answer });
    } catch (error) {
      if (stale() || isCancellation(error)) return;
      this.set({
        ...this.state,
        isAnswering: false,
        error: { key: null, text: this.deps.formatFailure(error) },
      });
    }
  }

  /**
   * Typed asks keep the last 90 s. An overview (the chips) reads the digest plus about 3 minutes,
   * or about 10 minutes when no digest exists yet, never past the engine's live budget.
   */
  private transcriptWindow(scope: LiveAskScope, hasDigest: boolean, budget: ContextBudget): string {
    const committed = this.deps.committedText();
    if (scope === 'recent') return takeRecentWindow(committed, DEFAULT_ANSWER_WINDOW_MS);
    const windowMs = hasDigest ? OVERVIEW_WINDOW_WITH_DIGEST_MS : OVERVIEW_WINDOW_NO_DIGEST_MS;
    const chars = hasDigest ? budget.liveTailWithDigestChars : budget.liveChars;
    return takeTail(takeRecentWindow(committed, windowMs), chars);
  }

  /** Stop and Discard (127). Silent: it only ends the answering state. */
  cancel(): void {
    this.begin();
    if (this.state.isAnswering) this.set({ ...this.state, isAnswering: false });
  }

  /** A new take: any answer goes, the web toggle stays (127, 114). */
  reset(): void {
    this.begin();
    this.asked = [];
    this.set({ ...IDLE, canUseWebSearch: this.state.canUseWebSearch });
    // The toggle must know the provider before the first ask.
    void this.refreshWebSupport();
  }

  /**
   * Bug 15: re-reads the provider and publishes the toggle state when it changed, so the pill
   * never shows a stale toggle after the provider changed in Settings mid-take.
   */
  async refreshWebSupport(): Promise<void> {
    try {
      const settings = await this.deps.loadSettings();
      const canUse = supportsWebSearch(settings.providerKind);
      if (canUse !== this.state.canUseWebSearch)
        this.set({ ...this.state, canUseWebSearch: canUse });
    } catch {
      // The next ask reads the settings again.
    }
  }

  /** Sends the current state again, for a window that opened after the last change. */
  republish(): void {
    this.deps.publish(this.state);
  }

  private remember(exchange: LiveAskExchange): void {
    this.asked = [...this.asked, exchange].slice(-LIVE_ASK_HISTORY_MAX);
  }

  private begin(): number {
    this.generation += 1;
    this.source?.cancel();
    this.source = null;
    return this.generation;
  }

  private set(state: LiveAnswerState): void {
    this.state = state;
    this.deps.publish(state);
  }

  /** Returns the whole raw buffer, or null when a newer owner took over. */
  private async stream(
    provider: Pick<SummaryProvider, 'streamPrompt'>,
    prompt: string,
    cancel: CancelSignal,
    stale: () => boolean,
  ): Promise<string | null> {
    let buffer = '';
    let seenVisible = false;
    let lastPublishMs = 0;
    for await (const chunk of provider.streamPrompt(prompt, cancel)) {
      if (stale()) return null;
      buffer += chunk;
      if (!seenVisible) {
        if (!hasVisible(chunk)) continue;
        seenVisible = true;
        lastPublishMs = this.deps.nowMs();
        this.set({ ...this.state, text: buffer.trimStart() });
      } else if (this.deps.nowMs() - lastPublishMs >= LIVE_ANSWER_FLUSH_MS) {
        lastPublishMs = this.deps.nowMs();
        this.set({ ...this.state, text: buffer.trimStart() });
      }
    }
    return stale() ? null : buffer;
  }
}
