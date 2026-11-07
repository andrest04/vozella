import { WEEKDAYS, isIsoDay, type ActionItem, type DeadlineKind } from '../library/meeting';
import { parseOffsetDate } from '../library/offset-date';

const DAY_MS = 86_400_000;

/** The meeting's local calendar day as a UTC-midnight timestamp, using its own offset. */
function meetingDay(recordedAt: string): number | null {
  const parsed = parseOffsetDate(recordedAt);
  if (!parsed) return null;
  const local = new Date(parsed.ms + parsed.offsetMinutes * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

const isoDay = (dayMs: number): string => new Date(dayMs).toISOString().slice(0, 10);

/** The meeting's local calendar day as `YYYY-MM-DD` (its recorded offset); null when unreadable. */
export function meetingLocalDay(recordedAt: string): string | null {
  const day = meetingDay(recordedAt);
  return day === null ? null : isoDay(day);
}

/**
 * Turns a deadline kind into `YYYY-MM-DD` in the meeting's calendar (its recorded offset, never
 * the machine zone). Rules:
 * - `date`: that date.
 * - `weekday`: the next such day strictly after the meeting day (Friday said on a Friday is the
 *   following Friday).
 * - `in_days`: the meeting day plus n days.
 * - `next_week`: the meeting day plus 7 days.
 * - `next_meeting`: `nextSessionDate` when it is a valid day, otherwise undefined.
 * - `unknown`, or an unreadable `recordedAt`: undefined. A date is never invented.
 */
export function resolveDeadline(
  kind: DeadlineKind,
  recordedAt: string,
  nextSessionDate?: string,
): string | undefined {
  if (kind.type === 'date') return kind.date;
  if (kind.type === 'next_meeting') {
    return nextSessionDate !== undefined && isIsoDay(nextSessionDate) ? nextSessionDate : undefined;
  }
  if (kind.type === 'unknown') return undefined;
  const day = meetingDay(recordedAt);
  if (day === null) return undefined;
  switch (kind.type) {
    case 'weekday': {
      const today = new Date(day).getUTCDay();
      const target = WEEKDAYS.indexOf(kind.weekday);
      return isoDay(day + ((target - today + 7) % 7 || 7) * DAY_MS);
    }
    case 'in_days':
      return isoDay(day + kind.days * DAY_MS);
    case 'next_week':
      return isoDay(day + 7 * DAY_MS);
  }
}

/** Fills `deadline.date` where it is missing and resolvable. Confirmed dates are kept. */
export function withResolvedDeadlines(
  items: readonly ActionItem[],
  recordedAt: string,
  nextSessionDate?: string,
): ActionItem[] {
  return items.map((item) => {
    const deadline = item.deadline;
    if (!deadline || deadline.date !== undefined) return item;
    const date = resolveDeadline(deadline.kind, recordedAt, nextSessionDate);
    return date === undefined ? item : { ...item, deadline: { ...deadline, date } };
  });
}
