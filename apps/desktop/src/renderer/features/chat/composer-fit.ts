/** One line of the message box: 20px line height plus its vertical padding. */
export const COMPOSER_MIN_HEIGHT = 32;
/** About four lines; past this the box scrolls instead of growing. */
export const COMPOSER_MAX_HEIGHT = 96;

export interface ComposerFit {
  readonly height: number;
  readonly overflowY: 'hidden' | 'auto';
}

/**
 * The message box height for a draft and its measured scroll height. An empty box is one line:
 * Chromium measures a wrapped placeholder too, which would grow the box and show a scrollbar. The
 * scrollbar appears only when the typed text is taller than the maximum.
 */
export function composerFit(draft: string, scrollHeight: number): ComposerFit {
  if (draft === '') return { height: COMPOSER_MIN_HEIGHT, overflowY: 'hidden' };
  return {
    height: Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, scrollHeight)),
    overflowY: scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden',
  };
}
