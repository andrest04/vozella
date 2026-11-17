import { foldText, foldedWords, hasAllWords } from '@vozella/core';
import { orderProjectChoices, type ProjectChoice } from './project-order';

/** One place a meeting can go. A null id is No project. */
export interface MoveOption {
  readonly projectId: string | null;
  readonly label: string;
}

/**
 * The places offered for moving meetings that are in `from` (one entry per meeting, null for no
 * project). The project every meeting is already in is left out, since moving there does nothing;
 * No project is offered when any meeting is in a project, and comes first. The query filters by
 * folded words; No project stays findable by its label.
 */
export function moveOptions(input: {
  readonly projects: readonly ProjectChoice[];
  readonly from: readonly (string | null)[];
  readonly query: string;
  readonly locale: string;
  readonly noProjectLabel: string;
}): readonly MoveOption[] {
  const known = new Set(input.projects.map((project) => project.id));
  // A project id that is not a project reads as no project.
  const places = input.from.map((id) => (id !== null && known.has(id) ? id : null));
  const sameFor =
    places.length > 0 && places.every((place) => place === places[0]) ? places[0] : undefined;
  const options: MoveOption[] = [];
  if (places.some((place) => place !== null)) {
    options.push({ projectId: null, label: input.noProjectLabel });
  }
  for (const project of orderProjectChoices(input.projects, input.locale)) {
    if (project.id !== sameFor) options.push({ projectId: project.id, label: project.name });
  }
  const words = foldedWords(input.query);
  return words.length === 0
    ? options
    : options.filter((option) => hasAllWords(foldText(option.label), words));
}
