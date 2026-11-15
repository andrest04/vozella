/**
 * A link into Settings that lands on the Transcription section: on the engine choice, or on the
 * API key field of the cloud engine in use. Pages navigate through the workspace, which carries
 * only the page tag, so the target waits here until the section reads it. A request is used once.
 * It never changes the engine in use.
 */
export type TranscriptionFocus = 'choice' | 'key';

let pending: TranscriptionFocus | null = null;
const listeners = new Set<(target: TranscriptionFocus) => void>();

/** Opens Settings with the Transcription section in view and the focus on `target`. */
export function openTranscriptionInSettings(target: TranscriptionFocus): void {
  pending = target;
  for (const listener of listeners) listener(target);
  void window.vozella
    .invoke('workspace.dispatch', { action: { type: 'navigateTo', tag: 'Settings' } })
    .catch(() => undefined);
}

/** The target a link asked for, once. */
export function takeTranscriptionFocus(): TranscriptionFocus | null {
  const target = pending;
  pending = null;
  return target;
}

/** Calls `listener` for links that arrive while Settings is already on screen. */
export function onTranscriptionFocus(listener: (target: TranscriptionFocus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
