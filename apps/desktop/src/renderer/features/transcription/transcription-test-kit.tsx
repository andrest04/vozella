import { act } from '@testing-library/react';
import type { TranscriptionSectionProps } from './TranscriptionSection';

type Listener = (payload: unknown) => void;
type Handler = (input: Record<string, unknown>) => unknown;

export const baseStatus = {
  ready: true,
  engine: 'Local',
  cloudNotReadyReason: null,
  modelInstalled: true,
  runtimes: { cpu: true, cuda: false },
  speakerModelInstalled: false,
  expectedBackend: 'cpu',
  usage: null,
  liveDroppedPercent: null,
  liveEnabled: true,
  speakerLabelsEnabled: false,
  language: 'es',
  installing: null,
};

type KeyAnswer =
  | { status: 'saved'; keySet: boolean }
  | { status: 'verified'; models: readonly string[] }
  | { status: 'failed'; errorKey: string };

/**
 * What the Settings page hands the Transcription section: which cloud keys are saved, the saved
 * cloud model, and the key commands. `keys` names the providers that have a key.
 */
export function sectionProps(
  options: { keys?: readonly string[]; cloudModel?: string | null } = {},
): {
  page: TranscriptionSectionProps['page'];
  model: TranscriptionSectionProps['model'] & {
    calls: { name: string; kind: string; key?: string }[];
  };
} {
  const saved = new Set(options.keys ?? []);
  const calls: { name: string; kind: string; key?: string }[] = [];
  const api = Object.fromEntries(
    ['OpenAi', 'Anthropic', 'Gemini', 'Groq', 'OpenAiCompatible'].map((kind) => [
      kind,
      { keySet: saved.has(kind), model: '', modelOptions: [], modelLabels: {}, baseUrl: null },
    ]),
  );
  return {
    page: {
      api,
      transcriptionKeys: {
        Groq: saved.has('Groq'),
        OpenAi: saved.has('OpenAi'),
        Deepgram: saved.has('Deepgram'),
        ElevenLabs: saved.has('ElevenLabs'),
      },
      settings: { cloudTranscriptionModelId: options.cloudModel ?? null },
    } as unknown as TranscriptionSectionProps['page'],
    model: {
      calls,
      load: () => Promise.resolve(),
      setApiKey: (kind, key): Promise<KeyAnswer> => {
        calls.push({ name: 'setApiKey', kind, key });
        return Promise.resolve({ status: 'saved', keySet: true });
      },
      clearApiKey: (kind): Promise<KeyAnswer> => {
        calls.push({ name: 'clearApiKey', kind });
        return Promise.resolve({ status: 'saved', keySet: false });
      },
      verifyApiKey: (kind): Promise<KeyAnswer> => {
        calls.push({ name: 'verifyApiKey', kind });
        return Promise.resolve({ status: 'verified', models: [] });
      },
    },
  };
}

/** A `window.vozella` for the transcription components: scripted answers and pushable events. */
export function installTranscriptionApi(handlers: Record<string, Handler> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const table: Record<string, Handler> = {
    'transcription.getStatus': () => baseStatus,
    ...handlers,
  };
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
