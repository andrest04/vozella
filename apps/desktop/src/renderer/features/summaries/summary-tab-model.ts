import type { SummaryTabStateDto } from '@vozella/contracts';

export type ActionItemDto = SummaryTabStateDto['actionItems'][number];
export type NotesMode = 'notes' | 'enhanced';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A confirmed `YYYY-MM-DD` as a short local day: "Fri 13 Nov", "vie 13 nov", with the year only
 * when it is not the current one. The day is a calendar day, so it is read as local midnight.
 */
export function formatDueDate(isoDay: string, locale: string, nowMs: number): string {
  const match = ISO_DAY.exec(isoDay);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return '';
  }
  const sameYear = year === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
    .format(date)
    .replace(/,/g, '');
}

/** The items a calendar export takes: open, with a date. */
export function exportableIndexes(items: readonly ActionItemDto[]): number[] {
  return items.flatMap((item, index) =>
    !item.isDone && item.deadline?.date !== undefined ? [index] : [],
  );
}

/** Some item said "next session" and has no date yet, so the tab asks when that is. */
export function awaitsNextSession(items: readonly ActionItemDto[]): boolean {
  return items.some(
    (item) => item.deadline?.kind.type === 'next_meeting' && item.deadline.date === undefined,
  );
}
