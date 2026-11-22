import type { ProjectListItemDto } from '@vozella/contracts';
import { foldText, foldedWords, hasAllWords } from '@vozella/core';

export type ProjectSort = 'recent' | 'name' | 'newest';

export const PROJECT_SORTS: readonly ProjectSort[] = ['recent', 'name', 'newest'];

export interface ProjectArrangement {
  /** Pinned projects, when any match, sorted by the same key as the rest. */
  readonly pinned: readonly ProjectListItemDto[];
  readonly others: readonly ProjectListItemDto[];
}

const instant = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

function comparer(
  sort: ProjectSort,
  locale: string,
): (a: ProjectListItemDto, b: ProjectListItemDto) => number {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const byName = (a: ProjectListItemDto, b: ProjectListItemDto): number =>
    collator.compare(foldText(a.name), foldText(b.name));
  switch (sort) {
    case 'name':
      return byName;
    case 'newest':
      return (a, b) => instant(b.createdAt) - instant(a.createdAt) || byName(a, b);
    case 'recent':
      return (a, b) => instant(b.lastActivityAt) - instant(a.lastActivityAt) || byName(a, b);
  }
}

/**
 * What the grid shows: the search applied to name and description by folded words (case and
 * accents do not count, word order does not matter), then one sort, then the pinned group.
 */
export function arrangeProjects(
  projects: readonly ProjectListItemDto[],
  options: { readonly query: string; readonly sort: ProjectSort; readonly locale: string },
): ProjectArrangement {
  const words = foldedWords(options.query);
  const matching =
    words.length === 0
      ? projects
      : projects.filter((project) =>
          hasAllWords(foldText(`${project.name} ${project.description}`), words),
        );
  const sorted = [...matching].sort(comparer(options.sort, options.locale));
  return {
    pinned: sorted.filter((project) => project.pinned),
    others: sorted.filter((project) => !project.pinned),
  };
}

/**
 * The last activity as a short day: "14 Nov", "14 nov", with the year only when it is not the
 * current one. Local time, like every date in the app. Empty for text that is not a date.
 */
export function formatActivity(iso: string, locale: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
    .format(new Date(ms))
    .replace(/\./g, '');
}
