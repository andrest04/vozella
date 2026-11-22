import { describe, expect, it } from 'vitest';
import type { Translate } from '../../i18n/translate';
import {
  INITIAL_VIEW,
  accessibleMessageText,
  chatViewReducer,
  coverageNote,
  keyIntent,
  restoreDraft,
  type ChatViewState,
} from './chat-view-model';

const msg = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  text,
  createdAt: '2026-09-01T09:00:00Z',
});

const started = (replace = false, from: ChatViewState = INITIAL_VIEW) =>
  chatViewReducer(from, { type: 'sendStarted', requestId: 'r1', text: 'Hello', replace });

describe('chatViewReducer', () => {
  it('adds the user row and a pending assistant row at once', () => {
    const state = started();
    expect(state.rows.map((r) => [r.role, r.text, r.pending])).toEqual([
      ['user', 'Hello', false],
      ['assistant', '', true],
    ]);
    expect(state.activeRequestId).toBe('r1');
  });

  it('clears the error when a send starts', () => {
    const failed = chatViewReducer(INITIAL_VIEW, {
      type: 'failed',
      error: { message: 'x', titled: true },
    });
    expect(started(false, failed).error).toBeNull();
  });

  it('streams the text so far into the pending row for the active request only', () => {
    let state = started();
    state = chatViewReducer(state, { type: 'chunk', requestId: 'other', text: 'no' });
    expect(state.rows[1]?.text).toBe('');
    state = chatViewReducer(state, { type: 'chunk', requestId: 'r1', text: 'Hi th' });
    state = chatViewReducer(state, { type: 'chunk', requestId: 'r1', text: 'Hi there' });
    expect(state.rows[1]).toMatchObject({ text: 'Hi there', pending: true });
  });

  it('swaps the optimistic rows for the real messages when answered', () => {
    let state = started();
    state = chatViewReducer(state, {
      type: 'answered',
      requestId: 'r1',
      user: msg('m1', 'user', 'Hello'),
      assistant: msg('m2', 'assistant', 'Hi'),
    });
    expect(state.rows.map((r) => [r.id, r.pending])).toEqual([
      ['m1', false],
      ['m2', false],
    ]);
    expect(state.activeRequestId).toBeNull();
  });

  it('removes both optimistic rows on rollback and keeps earlier messages', () => {
    let state = chatViewReducer(INITIAL_VIEW, {
      type: 'hydrate',
      messages: [msg('a', 'user', 'old'), msg('b', 'assistant', 'older')],
    });
    state = started(false, state);
    expect(state.rows).toHaveLength(4);
    state = chatViewReducer(state, { type: 'rolledBack', requestId: 'r1' });
    expect(state.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('starts a new list when the open conversation belongs to another scope', () => {
    let state = chatViewReducer(INITIAL_VIEW, {
      type: 'hydrate',
      messages: [msg('a', 'user', 'old')],
    });
    state = started(true, state);
    expect(state.rows.map((r) => r.text)).toEqual(['Hello', '']);
  });

  it('keeps the same pair when the gate resends under a new request id', () => {
    let state = started();
    state = chatViewReducer(state, { type: 'resend', requestId: 'r2' });
    state = chatViewReducer(state, { type: 'chunk', requestId: 'r2', text: 'ok' });
    expect(state.rows[1]?.text).toBe('ok');
    state = chatViewReducer(state, { type: 'rolledBack', requestId: 'r2' });
    expect(state.rows).toEqual([]);
  });

  it('does not let a server list overwrite rows while a send runs', () => {
    const state = chatViewReducer(started(), { type: 'hydrate', messages: [] });
    expect(state.rows).toHaveLength(2);
  });

  it('reset clears rows and error', () => {
    expect(chatViewReducer(started(), { type: 'reset' })).toEqual(INITIAL_VIEW);
  });
});

describe('restoreDraft', () => {
  it('restores only into an empty composer', () => {
    expect(restoreDraft('', 'question')).toBe('question');
    expect(restoreDraft('   ', 'question')).toBe('question');
    expect(restoreDraft('typed since', 'question')).toBe('typed since');
  });
});

describe('keyIntent', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    isComposing: false,
    draft: 'hi',
    sending: false,
  };
  it('sends on Enter and Ctrl+Enter', () => {
    expect(keyIntent(base)).toBe('send');
    expect(keyIntent({ ...base, ctrlKey: true })).toBe('send');
  });
  it('lets Shift+Enter insert a line', () => {
    expect(keyIntent({ ...base, shiftKey: true })).toBe('newline');
  });
  it('swallows Enter on an empty draft or while sending', () => {
    expect(keyIntent({ ...base, draft: '  ' })).toBe('swallow');
    expect(keyIntent({ ...base, sending: true })).toBe('swallow');
  });
  it('ignores Enter during IME composition and other keys', () => {
    expect(keyIntent({ ...base, isComposing: true })).toBe('ignore');
    expect(keyIntent({ ...base, key: 'a' })).toBe('ignore');
  });
});

describe('accessibleMessageText', () => {
  it('reads as role then text', () => {
    expect(accessibleMessageText('You', 'Hi')).toBe('You: Hi');
  });
});

describe('meeting coverage of an answer', () => {
  const coverage = { used: 12, matching: 37, basis: 'relevance' } as const;
  const answered = (over: { coverage?: typeof coverage } = {}) =>
    chatViewReducer(started(), {
      type: 'answered',
      requestId: 'r1',
      user: msg('m1', 'user', 'Hello'),
      assistant: msg('m2', 'assistant', 'Hi'),
      ...over,
    });

  it('stays with the answer row only', () => {
    const state = answered({ coverage });
    expect(state.rows.map((r) => [r.id, r.coverage])).toEqual([
      ['m1', undefined],
      ['m2', coverage],
    ]);
  });

  it('an answer without coverage has none', () => {
    expect(answered().rows.every((r) => r.coverage === undefined)).toBe(true);
  });

  it('survives a later server list of the same messages, not a different list', () => {
    const state = answered({ coverage });
    const same = chatViewReducer(state, {
      type: 'hydrate',
      messages: [msg('m1', 'user', 'Hello'), msg('m2', 'assistant', 'Hi')],
    });
    expect(same.rows.find((r) => r.id === 'm2')?.coverage).toEqual(coverage);
    const other = chatViewReducer(state, {
      type: 'hydrate',
      messages: [msg('x1', 'user', 'Old'), msg('x2', 'assistant', 'Reply')],
    });
    expect(other.rows.every((r) => r.coverage === undefined)).toBe(true);
  });
});

describe('coverageNote', () => {
  const t: Translate = (key, ...args) => [key, ...args].join('|');

  it('says nothing when every matching meeting was used, or there is no coverage', () => {
    expect(coverageNote(undefined, t)).toBeNull();
    expect(coverageNote({ used: 5, matching: 5, basis: 'recency' }, t)).toBeNull();
    expect(coverageNote({ used: 0, matching: 0, basis: 'recency' }, t)).toBeNull();
  });

  it('names how many were used of how many, by relevance or by recency', () => {
    expect(coverageNote({ used: 12, matching: 37, basis: 'relevance' }, t)).toBe(
      'Ui_ChatCoverageRelevant|12|37',
    );
    expect(coverageNote({ used: 12, matching: 37, basis: 'recency' }, t)).toBe(
      'Ui_ChatCoverageRecent|12|37',
    );
  });

  it('has its own sentence for a single meeting used', () => {
    expect(coverageNote({ used: 1, matching: 4, basis: 'relevance' }, t)).toBe(
      'Ui_ChatCoverageRelevantOne|4',
    );
    expect(coverageNote({ used: 1, matching: 4, basis: 'recency' }, t)).toBe(
      'Ui_ChatCoverageRecentOne|4',
    );
  });
});
