import { describe, expect, it } from 'vitest';
import { formatDeadlineKind, parseDeadlineKind } from '../library/meeting';
import { parseActionItems } from './action-items';

const one = (line: string, options?: Parameters<typeof parseActionItems>[1]) =>
  parseActionItems(line, options)[0];

describe('parseActionItems owner and deadline suffixes', () => {
  it('keeps items without suffixes exactly as before', () => {
    expect(parseActionItems('- [ ] Send the deck\n- [x] Book - the room')).toEqual([
      { text: 'Send the deck', isDone: false },
      { text: 'Book - the room', isDone: true },
    ]);
  });

  it('reads every kind token with its exact quote', () => {
    expect(one('- [ ] A — Owner: Ana — Due: date:2026-12-01 "on December 1st"')).toEqual({
      text: 'A',
      isDone: false,
      owner: 'Ana',
      deadline: { quote: 'on December 1st', kind: { type: 'date', date: '2026-12-01' } },
    });
    expect(one('- [ ] A — Due: weekday:fri "by Friday"')?.deadline).toEqual({
      quote: 'by Friday',
      kind: { type: 'weekday', weekday: 'fri' },
    });
    expect(one('- [ ] A — Due: in_days:3 "in three days"')?.deadline?.kind).toEqual({
      type: 'in_days',
      days: 3,
    });
    expect(one('- [ ] A — Due: next_week "next week"')?.deadline?.kind).toEqual({
      type: 'next_week',
    });
    expect(one('- [ ] A — Due: next_meeting "for next class"')?.deadline?.kind).toEqual({
      type: 'next_meeting',
    });
  });

  it('accepts en dash and hyphen separators, any label case and curly quotes', () => {
    expect(one('- [ ] A – owner: Ana – due: WEEKDAY:Mon “el lunes”')).toEqual({
      text: 'A',
      isDone: false,
      owner: 'Ana',
      deadline: { quote: 'el lunes', kind: { type: 'weekday', weekday: 'mon' } },
    });
    expect(one('- [ ] A - Owner: Ana - Due: next_week "la otra semana"')?.owner).toBe('Ana');
  });

  it('accepts the Spanish labels in any order', () => {
    expect(
      one(
        '- [ ] Traer el avance — Fecha: next_meeting "para la siguiente clase" — Responsable: Luis',
      ),
    ).toEqual({
      text: 'Traer el avance',
      isDone: false,
      owner: 'Luis',
      deadline: { quote: 'para la siguiente clase', kind: { type: 'next_meeting' } },
    });
  });

  it('keeps a legacy free-text deadline as an unknown kind with no date', () => {
    expect(one('- [ ] Send the deck — Owner: Ana — Due: Friday')).toEqual({
      text: 'Send the deck',
      isDone: false,
      owner: 'Ana',
      deadline: { quote: 'Friday', kind: { type: 'unknown' } },
    });
    expect(one('- [ ] A — Due: date:2026-02-30 "x"')?.deadline).toEqual({
      quote: 'date:2026-02-30 "x"',
      kind: { type: 'unknown' },
    });
  });

  it('drops an empty owner, a `none` deadline and an empty legacy deadline', () => {
    expect(one('- [ ] A — Owner: — Due: none')).toEqual({ text: 'A', isDone: false });
    expect(one('- [ ] A — Due:   ')).toEqual({ text: 'A', isDone: false });
  });

  it('keeps an empty quote when the model gave only the token', () => {
    expect(one('- [ ] A — Due: next_week')?.deadline).toEqual({
      quote: '',
      kind: { type: 'next_week' },
    });
  });

  it('does not split on a dash that is not followed by a label', () => {
    expect(one('- [ ] Review A — B — Owner: Ana')).toEqual({
      text: 'Review A — B',
      isDone: false,
      owner: 'Ana',
    });
  });

  it('resolves dates when the meeting date is given', () => {
    const options = { recordedAt: '2026-11-04T10:00:00-05:00', nextSessionDate: '2026-11-10' };
    expect(one('- [ ] A — Due: weekday:fri "el viernes"', options)?.deadline?.date).toBe(
      '2026-11-06',
    );
    expect(one('- [ ] A — Due: next_meeting "next class"', options)?.deadline?.date).toBe(
      '2026-11-10',
    );
    expect(one('- [ ] A — Due: Friday', options)?.deadline).toEqual({
      quote: 'Friday',
      kind: { type: 'unknown' },
    });
  });
});

describe('deadline kind tokens', () => {
  it('round-trips every kind', () => {
    for (const token of [
      'date:2026-12-01',
      'weekday:sun',
      'in_days:14',
      'next_week',
      'next_meeting',
      'unknown',
    ]) {
      const kind = parseDeadlineKind(token);
      expect(kind).not.toBeNull();
      if (kind) expect(formatDeadlineKind(kind)).toBe(token);
    }
  });

  it('rejects malformed tokens', () => {
    for (const token of [
      'date:2026-13-01',
      'weekday:fr',
      'in_days:-1',
      'in_days:99999',
      'soon',
      '',
    ]) {
      expect(parseDeadlineKind(token)).toBeNull();
    }
  });
});
