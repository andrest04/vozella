import type {
  ChatEngine,
  ChatProviderResolution,
  ModelChoice,
  ProviderSource,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { promptLogEntry, recordingProviderSource } from './chat-prompt-log';

const provider = {
  id: 'claude-code' as const,
  streamPrompt: () =>
    (async function* () {
      yield 'ok';
    })(),
};

describe('recordingProviderSource (e2e double)', () => {
  it('forwards the engine and choice, and records them with each prompt', async () => {
    const asked: [ChatEngine | undefined, ModelChoice | undefined][] = [];
    const source: ProviderSource = {
      resolve: (engine, choice) => {
        asked.push([engine, choice]);
        return Promise.resolve<ChatProviderResolution>({ status: 'ready', provider });
      },
    };
    const records: unknown[][] = [];
    const recording = recordingProviderSource(source, (...args) => records.push(args));
    const choice = { model: 'opus', effort: 'high' };
    const resolved = await recording.resolve('claude-code', choice);
    if (resolved.status !== 'ready') throw new Error('expected ready');
    const chunks: string[] = [];
    for await (const chunk of resolved.provider.streamPrompt('Q', {} as never)) chunks.push(chunk);
    expect(chunks).toEqual(['ok']);
    await recording.resolve();
    expect(asked).toEqual([
      ['claude-code', choice],
      [undefined, undefined],
    ]);
    expect(records).toEqual([['Q', 'claude-code', choice]]);
  });

  it('writes the model and effort lines only when the send carried them', () => {
    expect(promptLogEntry('Q', undefined, undefined)).toBe('Q\n<<<ENGINE local>>>\n<<<END>>>\n');
    expect(promptLogEntry('Q', 'codex', { model: 'gpt-5.5', effort: 'high' })).toBe(
      'Q\n<<<ENGINE codex>>>\n<<<MODEL gpt-5.5>>>\n<<<EFFORT high>>>\n<<<END>>>\n',
    );
  });
});
