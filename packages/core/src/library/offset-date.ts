/**
 * A date with its own UTC offset, as the library files store it. JavaScript dates have no offset,
 * so the stored text is parsed into this shape. Any fractional length is read (files written
 * earlier have seven digits); the writer always emits millisecond precision.
 */
export interface OffsetDate {
  /** The instant, in milliseconds since the epoch. */
  readonly ms: number;
  readonly offsetMinutes: number;
  /** Exactly seven digits: whatever the text had, padded or cut. */
  readonly fraction: string;
}

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0');

/** Offset of the machine's zone at a local wall-clock time, in minutes east of UTC. */
export function systemOffsetMinutes(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
) {
  return -new Date(year, month - 1, day, hour, minute).getTimezoneOffset();
}

/**
 * Parses an ISO 8601 date with offset. A value without an offset is read as local time, using
 * `localOffset` (default: the machine zone). Returns null when it is not a real date.
 */
export function parseOffsetDate(
  text: string,
  localOffset: (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ) => number = (y, mo, d, h, mi) => systemOffsetMinutes(y, mo, d, h, mi),
): OffsetDate | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = match;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = hs === undefined ? 0 : Number(hs);
  const minute = mis === undefined ? 0 : Number(mis);
  const second = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  let offsetMinutes: number;
  if (zone === undefined) {
    offsetMinutes = localOffset(year, month, day, hour, minute);
  } else if (zone.toUpperCase() === 'Z') {
    offsetMinutes = 0;
  } else {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const hh = Number(digits.slice(0, 2));
    const mm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (hh > 14 || mm > 59) return null;
    offsetMinutes = sign * (hh * 60 + mm);
  }

  const fraction = (frac ?? '').slice(0, 7).padEnd(7, '0');
  const ms = wall - offsetMinutes * 60_000 + Math.floor(Number(fraction) / 10_000);
  return { ms, offsetMinutes, fraction };
}

/**
 * How a date is written. `iso` is ISO-8601 with milliseconds and a numeric offset, e.g.
 * `2026-09-01T12:00:00.000-05:00`: what every stored file gets. `round-trip` keeps seven fraction
 * digits (`...00.0000000-05:00`) for the prompts that already carry that shape.
 */
export type OffsetDateStyle = 'iso' | 'round-trip';

export function formatOffsetDate(date: OffsetDate, style: OffsetDateStyle = 'iso'): string {
  const local = new Date(date.ms + date.offsetMinutes * 60_000);
  const day = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const sign = date.offsetMinutes < 0 ? '-' : '+';
  const offset = `${sign}${pad(Math.trunc(Math.abs(date.offsetMinutes) / 60))}:${pad(Math.abs(date.offsetMinutes) % 60)}`;
  const fraction = style === 'round-trip' ? date.fraction : date.fraction.slice(0, 3);
  return `${day}T${time}.${fraction}${offset}`;
}

/** The written form (`formatOffsetDate`) of any accepted input, or null when it is not a date. */
export function normalizeOffsetDate(text: string): string | null {
  const parsed = parseOffsetDate(text);
  return parsed ? formatOffsetDate(parsed) : null;
}

/** Now, as an OffsetDate in the machine's zone. */
export function offsetDateFromInstant(instant: Date, offsetMinutes?: number): OffsetDate {
  const offset = offsetMinutes ?? -instant.getTimezoneOffset();
  const ms = instant.getTime();
  return { ms, offsetMinutes: offset, fraction: `${pad(((ms % 1000) + 1000) % 1000, 3)}0000` };
}
