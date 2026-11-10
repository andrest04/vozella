import { act } from '@testing-library/react';

type Listener = (payload: unknown) => void;
type Handler = (input: Record<string, unknown>) => unknown;

/** A `window.vozella` for the provider setup: scripted answers, recorded calls, pushable events. */
export function installProviderApi(handlers: Record<string, Handler> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const table: Record<string, Handler> = { ...handlers };
  const invoke = (name: string, input: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, input });
    const handler = table[name];
    return handler ? Promise.resolve(handler(input)) : Promise.resolve({});
  };
  const on = (name: string, listener: Listener) => {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return () => {
      set.delete(listener);
    };
  };
  Object.defineProperty(window, 'vozella', {
    value: { invoke, on },
    configurable: true,
    writable: true,
  });
  const emit = (name: string, payload: unknown): void => {
    act(() => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    });
  };
  return { calls, emit, table };
}
