import type { SummaryTabStateDto } from '@vozella/contracts';

export type ActionItemDto = SummaryTabStateDto['actionItems'][number];
export type NotesMode = 'notes' | 'enhanced';

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
