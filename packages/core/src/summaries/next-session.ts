import { isIsoDay } from '../library/meeting';
import type { NextSessionDateStore } from '../library/ports';
import type { RawSettings } from '../library/settings';
import { meetingLocalDay } from './deadline-resolver';

/** The `settings.json` key that holds the remembered dates (unknown to `AppSettings`, kept as is). */
export const NEXT_SESSION_DATES_KEY = 'nextSessionDates';

/** A meeting title as a lookup key: trimmed, lowercased, inner whitespace collapsed to one space. */
export function nextSessionKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The date when it is a real day strictly after the meeting's local day. A remembered date on or
 * before that day belongs to an earlier session and is stale.
 */
export function usableNextSessionDate(
  date: string | null | undefined,
  recordedAt: string,
): string | undefined {
  if (date === null || date === undefined || !isIsoDay(date)) return undefined;
  const day = meetingLocalDay(recordedAt);
  return day !== null && date > day ? date : undefined;
}

/** The well-formed `title key -> YYYY-MM-DD` entries of raw settings; anything else is dropped. */
export function readNextSessionDates(raw: RawSettings): Record<string, string> {
  const value = raw[NEXT_SESSION_DATES_KEY];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const dates: Record<string, string> = {};
  for (const [key, date] of Object.entries(value as Record<string, unknown>)) {
    // `__proto__` would set the prototype instead of an entry.
    if (key !== '__proto__' && typeof date === 'string' && isIsoDay(date)) dates[key] = date;
  }
  return dates;
}

/** Raw settings with one remembered date set; every other key stays. */
export function withNextSessionDate(raw: RawSettings, titleKey: string, date: string): RawSettings {
  return {
    ...raw,
    [NEXT_SESSION_DATES_KEY]: { ...readNextSessionDates(raw), [titleKey]: date },
  };
}

/**
 * The remembered next-session date for a meeting, when it is still ahead of that meeting. A
 * missing store or a failed read is no date: generation must not fail for a convenience.
 */
export async function rememberedNextSessionDate(
  store: NextSessionDateStore | undefined,
  title: string,
  recordedAt: string,
): Promise<string | undefined> {
  if (store === undefined) return undefined;
  try {
    const date = await store.loadNextSessionDate(nextSessionKey(title));
    return usableNextSessionDate(date, recordedAt);
  } catch {
    return undefined;
  }
}
