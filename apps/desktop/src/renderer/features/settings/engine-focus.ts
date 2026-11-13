import type { EngineKind } from './engine-status';

/**
 * A link into Settings that opens one engine's row. Pages navigate through the workspace, which
 * carries only the page tag, so the engine waits here until the summary provider block reads it.
 * A request is used once; the next visit opens the engine in use again.
 */
let pending: EngineKind | null = null;
const listeners = new Set<(kind: EngineKind) => void>();

/** Opens Settings on `kind`'s row. It never changes the engine in use. */
export function openEngineInSettings(kind: EngineKind): void {
  pending = kind;
  for (const listener of listeners) listener(kind);
  void window.vozella
    .invoke('workspace.dispatch', { action: { type: 'navigateTo', tag: 'Settings' } })
    .catch(() => undefined);
}

/** The engine a link asked for, without using the request up. */
export function pendingEngineFocus(): EngineKind | null {
  return pending;
}

/** The engine a link asked for, once. */
export function takeEngineFocus(): EngineKind | null {
  const kind = pending;
  pending = null;
  return kind;
}

/** Calls `listener` for links that arrive while Settings is already on screen. */
export function onEngineFocus(listener: (kind: EngineKind) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
