import type { ActionItem } from '../library/meeting';
import type { SeriesContextInput } from './prompt-builders';

/** At most this many earlier related meetings feed the summary prompt. */
export const MAX_PRIOR_MEETINGS = 3;
export const MAX_FOLDER_NOTE_CHARS = 1500;
export const MAX_PRIOR_ITEMS_CHARS = 2000;
const MAX_ITEM_TEXT_CHARS = 200;
const MAX_ITEMS_PER_MEETING = 10;

export interface PriorMeetingItems {
  readonly title: string;
  /** Round-trip text; only its day (the first ten characters) is shown. */
  readonly recordedAt: string;
  readonly items: readonly ActionItem[];
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function itemLine(item: ActionItem): string {
  const owner = (item.owner ?? '').trim();
  const due = (item.deadline?.date ?? item.deadline?.quote ?? '').trim();
  return `- ${clip(item.text.trim(), MAX_ITEM_TEXT_CHARS)}${owner === '' ? '' : ` — Owner: ${owner}`}${due === '' ? '' : ` — Due: ${due}`}`;
}

/**
 * The series context for a summary prompt: the folder note and the unfinished action items of the
 * earlier related meetings (newest first), each part bounded. Null when both are empty.
 */
export function buildSeriesContext(
  folderNote: string | null | undefined,
  prior: readonly PriorMeetingItems[],
): SeriesContextInput | null {
  const note = (folderNote ?? '').trim();
  const sections: string[] = [];
  for (const meeting of prior) {
    const lines = meeting.items
      .filter((item) => !item.isDone && item.text.trim() !== '')
      .slice(0, MAX_ITEMS_PER_MEETING)
      .map(itemLine);
    if (lines.length === 0) continue;
    sections.push(
      `${meeting.title.trim()} (${meeting.recordedAt.slice(0, 10)})\n${lines.join('\n')}`,
    );
  }
  const items = clip(sections.join('\n\n'), MAX_PRIOR_ITEMS_CHARS);
  if (note === '' && items === '') return null;
  return {
    folderNote: note === '' ? null : clip(note, MAX_FOLDER_NOTE_CHARS),
    priorOpenItems: items === '' ? null : items,
  };
}
