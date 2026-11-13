import type {
  ChatEngine,
  ChatStreamProvider,
  ModelChoice,
  ProviderId,
  ProviderSource,
} from '@vozella/core';

/**
 * E2E double only (fake native build): every chat prompt is handed to `record` before the engine
 * sees it, with the engine that answers it and the model picker's choice, so a spec can prove
 * what reached which model (attached file text, a saved prompt's engine, a picked model).
 */
export function recordingProviderSource(
  source: ProviderSource,
  record: (prompt: string, engine: ProviderId | undefined, choice: ModelChoice | undefined) => void,
): ProviderSource {
  const wrap = (provider: ChatStreamProvider, choice?: ModelChoice): ChatStreamProvider => ({
    ...(provider.id === undefined ? {} : { id: provider.id }),
    streamPrompt: (prompt, cancel, options) => {
      record(prompt, provider.id, choice);
      return options === undefined
        ? provider.streamPrompt(prompt, cancel)
        : provider.streamPrompt(prompt, cancel, options);
    },
  });
  return {
    resolve: async (engine?: ChatEngine, choice?: ModelChoice) => {
      const resolution =
        engine === undefined
          ? await source.resolve()
          : choice === undefined
            ? await source.resolve(engine)
            : await source.resolve(engine, choice);
      return resolution.status === 'ready'
        ? { status: 'ready', provider: wrap(resolution.provider, choice) }
        : resolution;
    },
  };
}

/**
 * One prompt log entry: the prompt, the engine that answered it, and the model picker's model and
 * effort when the send carried them (each on its own line, so older specs read the log unchanged).
 */
export function promptLogEntry(
  prompt: string,
  engine: ProviderId | undefined,
  choice: ModelChoice | undefined,
): string {
  const model = choice?.model === undefined ? '' : `<<<MODEL ${choice.model}>>>\n`;
  const effort = choice?.effort === undefined ? '' : `<<<EFFORT ${choice.effort}>>>\n`;
  return `${prompt}\n<<<ENGINE ${engine ?? 'local'}>>>\n${model}${effort}<<<END>>>\n`;
}
