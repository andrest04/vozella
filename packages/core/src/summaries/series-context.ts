import { packAttachments, type AttachedDocument } from '../chat/attachments';
import { neutralizeStructure } from '../chat/context-packer';
import { cutPrefix } from '../chat/text-cut';
import type { ActionItem } from '../library/meeting';
import type { ProjectContextBudget } from '../projects/project-context';
import type { SeriesContextInput } from './prompt-builders';

/** At most this many earlier related meetings feed the summary prompt. */
export const MAX_PRIOR_MEETINGS = 3;
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

/** How much of the transcript helps pick the project file excerpts. */
const QUERY_TRANSCRIPT_CHARS = 2000;

/** What ranks the project file excerpts: the meeting title, the notes and the start of the transcript. */
export function summaryProjectQuery(
  title: string,
  notes: string | null | undefined,
  transcript: string,
): string {
  return [title.trim(), (notes ?? '').trim(), cutPrefix(transcript, QUERY_TRANSCRIPT_CHARS).trim()]
    .filter((part) => part !== '')
    .join('\n');
}

/** The project's two prompt blocks, already capped by the engine budget. */
export interface ProjectSummaryContext {
  readonly instructions: string | null;
  readonly files: string | null;
}

/**
 * The instructions (capped, then structure-neutralized so a forged `Id:` or `# ` line cannot pass
 * as prompt structure) and the files (whole when they fit, otherwise the excerpts that best match
 * `query`). Each part is null when empty.
 */
export function packProjectSummaryContext(
  data: { readonly instructions: string; readonly documents: readonly AttachedDocument[] },
  budget: ProjectContextBudget,
  query: string,
): ProjectSummaryContext {
  const instructions = neutralizeStructure(
    cutPrefix(data.instructions.trim(), budget.instructionsChars),
  ).trim();
  const files = packAttachments(data.documents, budget.filesChars, query).trim();
  return {
    instructions: instructions === '' ? null : instructions,
    files: files === '' ? null : files,
  };
}

/**
 * The series context for a summary prompt: the project's instructions and files and the
 * unfinished action items of the earlier related meetings (newest first), each part bounded. Null
 * when all are empty.
 */
export function buildSeriesContext(
  project: ProjectSummaryContext | null | undefined,
  prior: readonly PriorMeetingItems[],
): SeriesContextInput | null {
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
  const projectInstructions = project?.instructions ?? null;
  const projectFiles = project?.files ?? null;
  if (projectInstructions === null && projectFiles === null && items === '') return null;
  return { projectInstructions, projectFiles, priorOpenItems: items === '' ? null : items };
}
