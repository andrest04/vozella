import { describe, expect, it } from 'vitest';
import {
  buildLiveQa,
  formatLiveQaNotes,
  hasLiveTakeOutput,
  type LiveQaEntry,
} from './live-take-output';

const t = (key: string): string => `<${key}>`;

describe('buildLiveQa', () => {
  it('pairs a surfaced question with its answer, keeps unanswered ones, drops dismissed ones', () => {
    const qa = buildLiveQa(
      [
        { body: 'What is X?', atMs: 0, outcome: 'dismissed' },
        { body: 'What is Y?', atMs: 5, outcome: 'unanswered' },
        { body: 'What is Z?', atMs: 9, outcome: 'dismissed' },
      ],
      [{ question: ' what is x? ', answer: 'X is a letter.' }],
    );
    expect(qa).toEqual([
      { question: 'What is X?', answer: 'X is a letter.' },
      { question: 'What is Y?' },
    ]);
  });

  it('adds typed asks that match no surfaced question', () => {
    const qa = buildLiveQa([], [{ question: 'Why?', answer: 'Because.' }]);
    expect(qa).toEqual([{ question: 'Why?', answer: 'Because.' }]);
  });
});

describe('hasLiveTakeOutput', () => {
  it('is false for a blank digest and no Q&A', () => {
    expect(hasLiveTakeOutput({ digest: '  ', qa: [] })).toBe(false);
    expect(hasLiveTakeOutput({ digest: null, qa: [] })).toBe(false);
    expect(hasLiveTakeOutput({ digest: 'a', qa: [] })).toBe(true);
    expect(hasLiveTakeOutput({ digest: null, qa: [{ question: 'q' }] })).toBe(true);
  });
});

describe('formatLiveQaNotes', () => {
  it('is empty without Q&A', () => {
    expect(formatLiveQaNotes([], t)).toBe('');
  });

  it('writes a localized markdown block', () => {
    const qa: LiveQaEntry[] = [{ question: 'Why?', answer: 'Because.' }, { question: 'Who?' }];
    expect(formatLiveQaNotes(qa, t)).toBe(
      [
        '## <Ui_LiveQaHeading>',
        '',
        '**<Ui_LiveQaQuestion>:** Why?',
        '',
        '**<Ui_LiveQaAnswer>:** Because.',
        '',
        '**<Ui_LiveQaQuestion>:** Who?',
      ].join('\n'),
    );
  });
});
