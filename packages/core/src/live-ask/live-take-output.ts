import type { TranslateFn } from '../i18n/translator';
import type { LiveAskExchange } from './live-ask-session';
import type { LiveQuestionRecord } from './live-questions';

/** One question of the take and its answer; `answer` is absent when nobody answered it. */
export interface LiveQaEntry {
  readonly question: string;
  readonly answer?: string;
}

/** What the live pass of a take produced, read at Stop before the live state resets. */
export interface LiveTakeOutput {
  readonly digest: string | null;
  readonly qa: readonly LiveQaEntry[];
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The take's questions and answers in order. A surfaced question that was asked gets its answer; a
 * dismissed one nobody asked is dropped; one left on screen stays as an unanswered question. A
 * typed ask no card matches is added at the end.
 */
export function buildLiveQa(
  questions: readonly LiveQuestionRecord[],
  asks: readonly LiveAskExchange[],
): LiveQaEntry[] {
  const used = new Set<number>();
  const entries: LiveQaEntry[] = [];
  for (const question of questions) {
    const key = normalize(question.body);
    const at = asks.findIndex((ask, index) => !used.has(index) && normalize(ask.question) === key);
    const ask = at === -1 ? undefined : asks[at];
    if (ask !== undefined) {
      used.add(at);
      entries.push({ question: question.body, answer: ask.answer });
    } else if (question.outcome === 'unanswered') {
      entries.push({ question: question.body });
    }
  }
  asks.forEach((ask, index) => {
    if (!used.has(index)) entries.push({ question: ask.question, answer: ask.answer });
  });
  return entries;
}

export function hasLiveTakeOutput(output: LiveTakeOutput): boolean {
  return (output.digest ?? '').trim() !== '' || output.qa.length > 0;
}

/** The "Live Q&A" block saved with the meeting notes, in the language of `translate`. */
export function formatLiveQaNotes(qa: readonly LiveQaEntry[], translate: TranslateFn): string {
  if (qa.length === 0) return '';
  const question = translate('Ui_LiveQaQuestion');
  const answer = translate('Ui_LiveQaAnswer');
  const parts = qa.flatMap((entry) => [
    `**${question}:** ${entry.question}`,
    ...(entry.answer === undefined ? [] : [`**${answer}:** ${entry.answer}`]),
  ]);
  return [`## ${translate('Ui_LiveQaHeading')}`, ...parts].join('\n\n');
}
