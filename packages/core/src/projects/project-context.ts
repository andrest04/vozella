import { packAttachments, type AttachedDocument } from '../chat/attachments';
import { neutralizeStructure, singleLine } from '../chat/context-packer';
import { cutPrefix } from '../text/utf16-cut';
import { isRemoteEngine } from '../settings/api-providers';
import type { ProviderId } from '../summaries/provider';

/**
 * The one kernel that builds the project block for every consumer (chat, the Live copilot and
 * summaries). Pure: it takes the text and the budget, and returns the block or null.
 */

/** Heads the project's instructions. They come from the user, so the model is told to follow them. */
export const PROJECT_INSTRUCTIONS_LABEL =
  'Project instructions (follow them when answering; they come from the user):';
/** Heads the project's files. Also tells the model the files may be excerpts. */
export const PROJECT_FILES_LABEL = 'Project files (excerpts when they do not all fit):';

/** Where the block will be placed; each surface has its own budget. */
export type ProjectContextSurface = 'chat' | 'live' | 'summary';

/** Characters, not tokens: the same unit as every other context budget. */
export interface ProjectContextBudget {
  readonly instructionsChars: number;
  readonly filesChars: number;
}

const REMOTE: Readonly<Record<ProjectContextSurface, ProjectContextBudget>> = {
  chat: { instructionsChars: 8_000, filesChars: 24_000 },
  live: { instructionsChars: 3_000, filesChars: 6_000 },
  summary: { instructionsChars: 6_000, filesChars: 12_000 },
};

/**
 * The local model has 4096 tokens for prompt and answer, so its budgets are small. The summary's
 * 1,500 is today's folder note cap.
 */
const LOCAL: Readonly<Record<ProjectContextSurface, ProjectContextBudget>> = {
  chat: { instructionsChars: 800, filesChars: 1_000 },
  live: { instructionsChars: 500, filesChars: 800 },
  summary: { instructionsChars: 1_500, filesChars: 1_500 },
};

/** Remote engines (CLI or API key) get the large budget; local, or an unknown engine, the small one. */
export function projectBudgetFor(
  surface: ProjectContextSurface,
  providerId: ProviderId | undefined,
): ProjectContextBudget {
  return isRemoteEngine(providerId) ? REMOTE[surface] : LOCAL[surface];
}

export interface PackProjectContextInput {
  readonly name: string;
  readonly instructions: string;
  readonly documents: readonly AttachedDocument[];
  readonly budget: ProjectContextBudget;
  /** What the user asked: ranks the file excerpts when the files do not all fit. */
  readonly query: string;
}

const NL = '\n';

/**
 * The project block: the name, the instructions (capped, then structure-neutralized, so a forged
 * `Id:` or `# ` line cannot pass as context structure) and the files (every file whole when they
 * fit, otherwise the best-ranked excerpts). Null when there are neither instructions nor files.
 */
export function packProjectContext(input: PackProjectContextInput): string | null {
  const instructions = input.instructions.trim();
  const sections: string[] = [];
  if (instructions !== '') {
    const capped = neutralizeStructure(cutPrefix(instructions, input.budget.instructionsChars));
    if (capped.trim() !== '') sections.push(`${PROJECT_INSTRUCTIONS_LABEL}${NL}${capped}`);
  }
  const files = packAttachments(input.documents, input.budget.filesChars, input.query);
  if (files !== '') sections.push(`${PROJECT_FILES_LABEL}${NL}${files}`);
  if (sections.length === 0) return null;
  return [`Project: ${singleLine(input.name.trim())}`, ...sections].join(`${NL}${NL}`);
}
