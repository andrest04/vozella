import { SESSION_TABS, type SessionTab } from '../library/workspace';

export type SlideDirection = 'FromRight' | 'FromLeft';

export function tabIndex(tab: SessionTab): number {
  return SESSION_TABS.indexOf(tab);
}

/** A higher index slides in from the right, anything else from the left. */
export function slideDirection(prevIndex: number, nextIndex: number): SlideDirection {
  return nextIndex > prevIndex ? 'FromRight' : 'FromLeft';
}

/**
 * The previous index is updated on every navigation, including same-tab reloads, and
 * starts at the opened tab, so a first reload never slides from the wrong side.
 */
export function createSlideTracker(initialTab: SessionTab): {
  navigate(tab: SessionTab): SlideDirection;
} {
  let prev = tabIndex(initialTab);
  return {
    navigate(tab) {
      const next = tabIndex(tab);
      const direction = slideDirection(prev, next);
      prev = next;
      return direction;
    },
  };
}
