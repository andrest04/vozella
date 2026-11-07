import type { ActionItem } from '../library/meeting';

/** An action item with its position in the meeting, so its UID stays stable across exports. */
export interface IcsActionItemEntry {
  readonly index: number;
  readonly item: ActionItem;
}

export interface ActionItemsIcsRequest {
  readonly meetingTitle: string;
  readonly items: readonly IcsActionItemEntry[];
  /** The export moment, written as `DTSTAMP`. */
  readonly now: Date;
  /** Usually the meeting id: with the index and text it makes each event's UID. */
  readonly uidSeed: string;
  /** Description labels; English when omitted. */
  readonly labels?: { readonly owner: string; readonly meeting: string };
}

export interface ActionItemsIcs {
  readonly text: string;
  /** Events written: the items that had a date. */
  readonly count: number;
}

const CRLF = '\r\n';
const MAX_OCTETS = 75;
/** UTF-8 length of one code point (core has no `TextEncoder` types). */
const utf8Octets = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/** RFC 5545 3.3.11 TEXT escaping: backslash, semicolon, comma and line breaks. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 3.1 folding: no physical line longer than 75 octets; each continuation starts with
 * one space (which counts). Splits between code points, never inside a UTF-8 sequence.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = utf8Octets(char);
    if (octets + size > MAX_OCTETS) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(CRLF);
}

/** FNV-1a over UTF-16 code units, 32 bits, with a chosen offset basis. */
function fnv1a(text: string, basis: number): string {
  let hash = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const stableUid = (seed: string, index: number, text: string): string => {
  const key = `${seed}\u0000${String(index)}\u0000${text}`;
  return `${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x050c5d1f)}@vozella`;
};

const compactDay = (isoDay: string): string => isoDay.replace(/-/g, '');

function nextDay(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const utcStamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

function description(
  item: ActionItem,
  meetingTitle: string,
  labels: { readonly owner: string; readonly meeting: string },
): string {
  const lines: string[] = [];
  const owner = item.owner?.trim() ?? '';
  if (owner !== '') lines.push(`${labels.owner}: ${owner}`);
  const quote = item.deadline?.quote.trim() ?? '';
  if (quote !== '') lines.push(`"${quote}"`);
  lines.push(`${labels.meeting}: ${meetingTitle}`);
  return lines.join('\n');
}

const MAX_FILE_STEM = 100;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const FORBIDDEN_IN_FILE_NAME = '<>:"/\\|?*';

/**
 * A safe default file name for the export: the meeting title without characters Windows refuses
 * (`<>:"/\|?*` and control characters), spaces collapsed, no trailing dots, at most 100
 * characters, plus `.ics`. Falls back to `action-items.ics`.
 */
export function icsFileName(meetingTitle: string): string {
  let kept = '';
  for (const char of meetingTitle.replace(/\s+/g, ' ')) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f && !FORBIDDEN_IN_FILE_NAME.includes(char)) kept += char;
  }
  const stem = kept
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MAX_FILE_STEM)
    // A cut between the halves of a surrogate pair drops the lone half.
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/[. ]+$/, '');
  return `${stem === '' || RESERVED_NAME.test(stem) ? 'action-items' : stem}.ics`;
}

/**
 * The selected action items as an iCalendar file: one all-day, transparent `VEVENT` per item with
 * a date (Google Calendar ignores `VTODO`). Items without a date are skipped. Pure: the caller
 * gives the clock and the UID seed.
 */
export function buildActionItemsIcs(request: ActionItemsIcsRequest): ActionItemsIcs {
  const labels = request.labels ?? { owner: 'Owner', meeting: 'Meeting' };
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vozella//Action Items//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const stamp = utcStamp(request.now);
  let count = 0;
  for (const { index, item } of request.items) {
    const date = item.deadline?.date;
    if (date === undefined) continue;
    count += 1;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${stableUid(request.uidSeed, index, item.text)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDay(date)}`,
      `DTEND;VALUE=DATE:${compactDay(nextDay(date))}`,
      `SUMMARY:${escapeIcsText(item.text)}`,
      `DESCRIPTION:${escapeIcsText(description(item, request.meetingTitle, labels))}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(foldIcsLine).join(CRLF) + CRLF, count };
}
