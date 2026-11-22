import type { EngineKind } from './engine-status';

/**
 * Where a link into Settings lands: one engine's row, or `in-use`, the engine in use (the first
 * engine's row when none is in use, so the user can pick one).
 */
export type EngineFocus = EngineKind | 'in-use';

/**
 * A link into Settings that opens one engine's row. Pages navigate through the workspace, which
 * carries only the page tag, so the engine waits here until the summary provider block reads it.
 * A request is used once; the next visit opens the engine in use again.
 */
let pending: EngineFocus | null = null;
const listeners = new Set<(focus: EngineFocus) => void>();

/** Opens Settings on `focus`'s row. It never changes the engine in use. */
export function openEngineInSettings(focus: EngineFocus): void {
  pending = focus;
  for (const listener of listeners) listener(focus);
  void window.vozella
    .invoke('workspace.dispatch', { action: { type: 'navigateTo', tag: 'Settings' } })
    .catch(() => undefined);
}

/** The engine a link asked for, without using the request up. */
export function pendingEngineFocus(): EngineFocus | null {
  return pending;
}

/** The engine a link asked for, once. */
export function takeEngineFocus(): EngineFocus | null {
  const focus = pending;
  pending = null;
  return focus;
}

/** Calls `listener` for links that arrive while Settings is already on screen. */
export function onEngineFocus(listener: (focus: EngineFocus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The main window follows `recording.answerSetupRequested` (the setup action of a live answer
 * that found no summary engine, sent by main once the window is in front) to the engine in use.
 * Only the main window connects it: the pill has no Settings.
 */
export function connectEngineSetupRequests(): () => void {
  return window.vozella.on('recording.answerSetupRequested', () => {
    openEngineInSettings('in-use');
  });
}
