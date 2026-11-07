import { describe, expect, it } from 'vitest';
import type { ActionItem } from '../library/meeting';
import { buildActionItemsIcs, escapeIcsText, foldIcsLine, icsFileName } from './action-items-ics';

const now = new Date('2026-11-06T14:05:09.000Z');
/** UTF-8 octets; `encodeURIComponent` throws on a lone surrogate, so a split pair fails too. */
const bytes = (text: string): number =>
  encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length;
const unfold = (text: string): string => text.replace(/\r\n /g, '');

const dated = (text: string, date: string, extra: Partial<ActionItem> = {}): ActionItem => ({
  text,
  isDone: false,
  deadline: { quote: 'by Friday', kind: { type: 'weekday', weekday: 'fri' }, date },
  ...extra,
});

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma and every newline form', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
  });
});

describe('foldIcsLine', () => {
  it('leaves a line of 75 octets alone', () => {
    const line = 'x'.repeat(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds at 75 octets with a leading space on each continuation', () => {
    const folded = foldIcsLine('y'.repeat(200));
    const lines = folded.split('\r\n');
    expect(lines[0]).toHaveLength(75);
    for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(true);
    for (const line of lines) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe('y'.repeat(200));
  });

  it('never splits a multi-byte character (accented text)', () => {
    const text = `SUMMARY:${'Revisión del capítulo ñandú, acción pendiente '.repeat(6)}`;
    const folded = foldIcsLine(text);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(bytes(line)).toBeLessThanOrEqual(75);
    // Full lines: a fold happens only when the next character would not fit.
    for (const line of lines.slice(0, -1)) expect(bytes(line)).toBeGreaterThanOrEqual(74);
    expect(unfold(folded)).toBe(text);
  });

  it('keeps an emoji (surrogate pair) whole', () => {
    const text = `X:${'😀'.repeat(40)}`;
    const lines = foldIcsLine(text).split('\r\n');
    for (const line of lines) {
      expect(bytes(line)).toBeLessThanOrEqual(75);
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(unfold(lines.join('\r\n'))).toBe(text);
  });
});

describe('buildActionItemsIcs', () => {
  const build = (items: readonly { index: number; item: ActionItem }[], title = 'Weekly sync') =>
    buildActionItemsIcs({ meetingTitle: title, items, now, uidSeed: 'meeting-1' });

  it('writes a publishable calendar with one all-day event per dated item', () => {
    const { text, count } = build([
      { index: 0, item: dated('Send the deck', '2026-11-13', { owner: 'Ana' }) },
    ]);
    expect(count).toBe(1);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    const lines = unfold(text).split('\r\n');
    expect(lines.slice(0, 5)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Vozella//Action Items//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ]);
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('DTSTAMP:20261106T140509Z');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261113');
    expect(lines).toContain('DTEND;VALUE=DATE:20261114');
    expect(lines).toContain('SUMMARY:Send the deck');
    expect(lines).toContain('DESCRIPTION:Owner: Ana\\n"by Friday"\\nMeeting: Weekly sync');
    expect(lines).toContain('TRANSP:TRANSPARENT');
    expect(lines).toContain('END:VEVENT');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(lines.find((line) => line.startsWith('UID:'))).toMatch(/^UID:[0-9a-f]{16}@vozella$/);
  });

  it('ends DTEND on the next day across a month and a year boundary', () => {
    const { text } = build([{ index: 0, item: dated('Close books', '2026-12-31') }]);
    expect(text).toContain('DTSTART;VALUE=DATE:20261231\r\n');
    expect(text).toContain('DTEND;VALUE=DATE:20270101\r\n');
  });

  it('skips items without a date and counts only the written events', () => {
    const { text, count } = build([
      { index: 0, item: { text: 'No deadline', isDone: false } },
      {
        index: 1,
        item: {
          text: 'Next class',
          isDone: false,
          deadline: { quote: 'next class', kind: { type: 'next_meeting' } },
        },
      },
      { index: 2, item: dated('Dated', '2026-11-10') },
    ]);
    expect(count).toBe(1);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).not.toContain('No deadline');
  });

  it('an empty selection still writes a valid calendar with no events', () => {
    const { text, count } = build([]);
    expect(count).toBe(0);
    expect(text).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Vozella//Action Items//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });

  it('UIDs are stable for the same item and differ by index or text', () => {
    const uid = (index: number, text: string, seed = 'meeting-1') =>
      /UID:(\S+)/.exec(
        buildActionItemsIcs({
          meetingTitle: 'T',
          items: [{ index, item: dated(text, '2026-11-10') }],
          now,
          uidSeed: seed,
        }).text,
      )?.[1];
    expect(uid(0, 'a')).toBe(uid(0, 'a'));
    expect(uid(0, 'a')).not.toBe(uid(1, 'a'));
    expect(uid(0, 'a')).not.toBe(uid(0, 'b'));
    expect(uid(0, 'a')).not.toBe(uid(0, 'a', 'meeting-2'));
  });

  it('escapes text fields and folds long accented summaries', () => {
    const longText = 'Preparar la presentación del capítulo, revisar acción; añadir ñandú '.repeat(
      2,
    );
    const { text } = build(
      [{ index: 0, item: dated(longText, '2026-11-10', { owner: 'José, María' }) }],
      'Clase: Diseño; grupo A',
    );
    for (const line of text.split('\r\n')) expect(bytes(line)).toBeLessThanOrEqual(75);
    const lines = unfold(text).split('\r\n');
    expect(lines).toContain(`SUMMARY:${escapeIcsText(longText)}`);
    expect(lines.find((line) => line.startsWith('DESCRIPTION:'))).toBe(
      'DESCRIPTION:Owner: José\\, María\\n"by Friday"\\nMeeting: Clase: Diseño\\; grupo A',
    );
  });

  it('leaves out a missing owner or a blank quote from the description', () => {
    const { text } = build([
      {
        index: 0,
        item: {
          text: 'Picked by hand',
          isDone: false,
          deadline: { quote: '', kind: { type: 'date', date: '2026-11-10' }, date: '2026-11-10' },
        },
      },
    ]);
    expect(unfold(text)).toContain('DESCRIPTION:Meeting: Weekly sync\r\n');
  });

  it('uses the given labels for the description', () => {
    const { text } = buildActionItemsIcs({
      meetingTitle: 'Clase',
      items: [{ index: 0, item: dated('Tarea', '2026-11-10', { owner: 'Ana' }) }],
      now,
      uidSeed: 'm',
      labels: { owner: 'Responsable', meeting: 'Reunión' },
    });
    expect(unfold(text)).toContain('DESCRIPTION:Responsable: Ana\\n"by Friday"\\nReunión: Clase');
  });
});

describe('icsFileName', () => {
  it('keeps a plain title and adds the extension', () => {
    expect(icsFileName('Diseño de Software')).toBe('Diseño de Software.ics');
  });

  it('drops characters Windows refuses, control characters and trailing dots', () => {
    expect(icsFileName(' Q3: plan / review? <draft>*|"x"\t. ')).toBe('Q3 plan review draftx.ics');
  });

  it('falls back for a blank or reserved name and caps the length', () => {
    expect(icsFileName('  ')).toBe('action-items.ics');
    expect(icsFileName('???')).toBe('action-items.ics');
    expect(icsFileName('CON')).toBe('action-items.ics');
    expect(icsFileName('a'.repeat(300))).toBe(`${'a'.repeat(100)}.ics`);
  });
});
