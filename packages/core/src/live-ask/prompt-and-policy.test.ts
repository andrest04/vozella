import { describe, expect, it } from 'vitest';
import { buildLiveAnswerPrompt } from './prompt-builder';
import { shouldUseWeb, supportsWebSearch } from './web-policy';

describe('LiveAnswerPromptBuilder', () => {
  it('Spanish prompt carries the question, the window and the fixed rules', () => {
    const p = buildLiveAnswerPrompt('What is DNS?', 'window text', 'es');
    for (const part of [
      'What is DNS?',
      'window text',
      'If the transcript does not contain the factual answer, answer from knowledge.',
      'Do not refuse just because the meeting did not state the fact.',
      'Do not say that you only know what was said.',
      'Spanish',
      '2 to 5 sentences',
      'live class or meeting',
      'who asked',
    ]) {
      expect(p).toContain(part);
    }
  });

  it('English asks for English and omits Spanish', () => {
    const p = buildLiveAnswerPrompt('q', 'w', ' EN ');
    expect(p).toContain('in English.');
    expect(p).not.toContain('Spanish');
  });

  it.each([null, undefined, 'fr', ''])('language %s falls back to Spanish', (language) => {
    const p = buildLiveAnswerPrompt('q', 'w', language);
    expect(p).toContain('Write the answer in Spanish.');
    expect(p).not.toContain('English');
    expect(p).not.toContain('French');
  });

  it('session context adds its block directly above Question', () => {
    const p = buildLiveAnswerPrompt('q', 'w', 'en', '  Meeting: Math  ');
    expect(p).toContain('Session context:\nMeeting: Math\n\nThe session context is');
    expect(p).toContain('interpret the question.\nQuestion:\nq');
  });

  it.each([null, '', '   '])('blank context %j omits the block', (context) => {
    expect(buildLiveAnswerPrompt('q', 'w', 'en', context)).not.toContain('Session context');
  });

  it('web search adds the web line with a blank line after it', () => {
    const p = buildLiveAnswerPrompt('q', 'w', 'en', null, true);
    expect(p).toContain(
      '(competitors, prices, recent news) and keep the answer short.\n\nQuestion:',
    );
  });

  it('without web search the word web never appears', () => {
    expect(buildLiveAnswerPrompt('q', 'w', 'es', 'ctx', false).toLowerCase()).not.toContain('web');
  });

  it('context plus web keeps the question and window sections', () => {
    const p = buildLiveAnswerPrompt('the q', 'the w', 'en', 'ctx', true);
    expect(p.endsWith('Question:\nthe q\n\nTranscript window:\nthe w')).toBe(true);
    expect(p).toContain('Session context:\nctx');
  });

  it('null question and window become empty', () => {
    expect(
      buildLiveAnswerPrompt(null, null, 'en').endsWith('Question:\n\n\nTranscript window:\n'),
    ).toBe(true);
  });
});

describe('LiveAnswerPromptBuilder layout', () => {
  const head = [
    'You are answering a question that was just asked in a live class or meeting.',
    '',
    'Write a short answer in 2 to 5 sentences. Write the answer in English.',
    '',
    'Use the transcript window as context for the topic and who asked.',
    '',
    'If the transcript does not contain the factual answer, answer from knowledge. Do not refuse just because the meeting did not state the fact. Do not say that you only know what was said.',
    '',
  ];
  const tail = ['Question:', 'Why?', '', 'Transcript window:', 'the window'];
  const contextLines = [
    'Session context:',
    'Meeting: Math',
    '',
    'The session context is the topic, course, or meeting brief supplied by the user. Use it to interpret the question.',
  ];
  const webLines = [
    'You may use web search for current or external facts (competitors, prices, recent news) and keep the answer short.',
    '',
  ];

  it('plain prompt, byte for byte', () => {
    expect(buildLiveAnswerPrompt('Why?', 'the window', 'en')).toBe([...head, ...tail].join('\n'));
  });

  it('context only: no blank line between the block and Question', () => {
    expect(buildLiveAnswerPrompt('Why?', 'the window', 'en', 'Meeting: Math')).toBe(
      [...head, ...contextLines, ...tail].join('\n'),
    );
  });

  it('web only: the web line, a blank line, then Question', () => {
    expect(buildLiveAnswerPrompt('Why?', 'the window', 'en', null, true)).toBe(
      [...head, ...webLines, ...tail].join('\n'),
    );
  });

  it('both: context block, then web line, then a blank line', () => {
    expect(buildLiveAnswerPrompt('Why?', 'the window', 'en', 'Meeting: Math', true)).toBe(
      [...head, ...contextLines, ...webLines, ...tail].join('\n'),
    );
  });

  it('has no trailing newline after the window and no web word without web search', () => {
    const p = buildLiveAnswerPrompt('Why?', 'the window', 'es', 'Meeting: Math', false);
    expect(p.endsWith('the window')).toBe(true);
    expect(/web/i.test(p)).toBe(false);
  });
});

describe('LiveAnswerWebPolicy', () => {
  it('only the CLI providers support web search', () => {
    expect(supportsWebSearch('ClaudeCode')).toBe(true);
    expect(supportsWebSearch('Codex')).toBe(true);
    expect(supportsWebSearch('Xai')).toBe(false);
    expect(supportsWebSearch('Local')).toBe(false);
  });

  it('the typed question uses the web only when supported and forced', () => {
    expect(shouldUseWeb(true, true)).toBe(true);
    expect(shouldUseWeb(true, false)).toBe(false);
    expect(shouldUseWeb(false, true)).toBe(false);
    expect(shouldUseWeb(false, false)).toBe(false);
  });
});
