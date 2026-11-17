import type {
  EventChannels,
  EventName,
  InputOf,
  OutputOf,
  PayloadOf,
  RequestChannels,
  RequestName,
} from '@vozella/contracts';

type Handler<N extends RequestName> = (
  input: InputOf<RequestChannels[N]>,
) => OutputOf<RequestChannels[N]> | Promise<OutputOf<RequestChannels[N]>>;

/** Answers for the channels a test cares about. Any other channel the page calls fails the test. */
export type VozellaHandlers = { [N in RequestName]?: Handler<N> };

export interface VozellaCall {
  readonly name: string;
  readonly input: unknown;
}

type Listener = (payload: unknown) => void;

export interface VozellaMock {
  readonly calls: VozellaCall[];
  /** Inputs of the calls to one channel, in order. */
  inputsOf: (name: RequestName) => unknown[];
  /** Replaces or adds the answer of one channel. */
  handle: <N extends RequestName>(name: N, handler: Handler<N>) => void;
  /** Delivers an event to the page, as the main process would. */
  emit: <N extends EventName>(name: N, payload: PayloadOf<EventChannels[N]>) => void;
  listenerCount: (name: EventName) => number;
}

/**
 * A typed stand in for `window.vozella`: every handler is checked against the channel's contract,
 * so a test cannot answer with a shape the real main process would never send.
 */
export function installVozella(initial: VozellaHandlers = {}): VozellaMock {
  const handlers = new Map<string, (input: unknown) => unknown>(
    Object.entries(initial) as [string, (input: unknown) => unknown][],
  );
  const listeners = new Map<string, Set<Listener>>();
  const calls: VozellaCall[] = [];

  const api = {
    invoke: (name: string, input: unknown): Promise<unknown> => {
      calls.push({ name, input });
      const handler = handlers.get(name);
      if (!handler) return Promise.reject(new Error(`vozella mock: unhandled ${name}`));
      try {
        return Promise.resolve(handler(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    on: (name: string, listener: Listener): (() => void) => {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(name, set);
      return () => {
        set.delete(listener);
      };
    },
  };
  Object.defineProperty(window, 'vozella', { value: api, configurable: true, writable: true });

  return {
    calls,
    inputsOf: (name) => calls.filter((call) => call.name === name).map((call) => call.input),
    handle: (name, handler) => {
      handlers.set(name, handler as (input: unknown) => unknown);
    },
    emit: (name, payload) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
    },
    listenerCount: (name) => listeners.get(name)?.size ?? 0,
  };
}

export function uninstallVozella(): void {
  Reflect.deleteProperty(window, 'vozella');
}
