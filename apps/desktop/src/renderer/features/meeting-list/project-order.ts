import type { ProjectListItemDto } from '@vozella/contracts';
import { foldText } from '@vozella/core';

/** What a list of places needs of a project. */
export type ProjectChoice = Pick<ProjectListItemDto, 'id' | 'name' | 'pinned'>;

/**
 * The order places are offered in, wherever a project is chosen (record destination, Move to
 * project): pinned projects first, then the rest, each group by folded name. Flat, no paths.
 */
export function orderProjectChoices<T extends ProjectChoice>(
  projects: readonly T[],
  locale: string,
): readonly T[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const byName = (a: T, b: T): number => collator.compare(foldText(a.name), foldText(b.name));
  return [
    ...projects.filter((project) => project.pinned).sort(byName),
    ...projects.filter((project) => !project.pinned).sort(byName),
  ];
}
