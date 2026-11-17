import { orderProjectChoices, type ProjectChoice } from '../meeting-list/project-order';

export interface Destination {
  /** Null is No project. */
  readonly projectId: string | null;
  readonly label: string;
}

/**
 * Where a take can be saved: No project first, then the pinned projects, then the rest by name.
 * Flat: a project has no parent, so a label is only its name.
 */
export function buildDestinations(
  projects: readonly ProjectChoice[],
  noProjectLabel: string,
  locale: string,
): Destination[] {
  return [
    { projectId: null, label: noProjectLabel },
    ...orderProjectChoices(projects, locale).map((project) => ({
      projectId: project.id,
      label: project.name,
    })),
  ];
}

/** The reload keeps the chosen project while it exists and falls back to No project otherwise. */
export function retainDestination(
  projectId: string | null,
  destinations: readonly Destination[],
): string | null {
  return destinations.some((destination) => destination.projectId === projectId) ? projectId : null;
}

/** The Select works with strings; No project needs a value of its own. */
export const NO_PROJECT_VALUE = '__none__';
export const toOptionValue = (projectId: string | null): string => projectId ?? NO_PROJECT_VALUE;
export const fromOptionValue = (value: string): string | null =>
  value === NO_PROJECT_VALUE ? null : value;
