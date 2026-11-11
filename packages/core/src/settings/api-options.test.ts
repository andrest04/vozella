import { describe, expect, it } from 'vitest';
import { InMemorySettingsStore } from '../library';
import { SettingsCommands } from './commands';

function commands() {
  const store = new InMemorySettingsStore();
  return { store, commands: new SettingsCommands({ store, osLanguages: () => ['en-US'] }) };
}

describe('SettingsCommands: API key engines', () => {
  it.each(['OpenAi', 'Anthropic', 'Gemini', 'OpenAiCompatible'])(
    'selects %s as the summary engine',
    async (kind) => {
      const { store, commands: c } = commands();
      expect(await c.setSummaryProvider(kind)).toMatchObject({ status: 'saved' });
      expect((await store.load()).selectedSummaryProvider).toBe(kind);
    },
  );

  it('saves a model id, suggested or typed, trimmed, with the feedback line', async () => {
    const { store, commands: c } = commands();
    expect(
      await c.setApiOption({ kind: 'OpenAi', field: 'model', value: ' gpt-5 ' }),
    ).toMatchObject({ status: 'saved', feedback: { key: 'Xai_FeedbackModel', args: ['gpt-5'] } });
    expect((await store.load()).selectedOpenAiModelId).toBe('gpt-5');
    // Free text: a model the list does not suggest is still saved.
    await c.setApiOption({ kind: 'Anthropic', field: 'model', value: 'claude-custom-1' });
    expect((await store.load()).selectedAnthropicModelId).toBe('claude-custom-1');
  });

  it('ignores a blank, unchanged or whitespace-bearing model id', async () => {
    const { commands: c } = commands();
    expect(await c.setApiOption({ kind: 'Gemini', field: 'model', value: '  ' })).toEqual({
      status: 'ignored',
      reason: 'blank',
    });
    expect(
      await c.setApiOption({ kind: 'Gemini', field: 'model', value: 'gemini-3.8-flash' }),
    ).toEqual({ status: 'ignored', reason: 'unchanged' });
    expect(await c.setApiOption({ kind: 'Gemini', field: 'model', value: 'two words' })).toEqual({
      status: 'ignored',
      reason: 'invalid',
    });
  });

  it('saves an http or https base URL for the compatible engine, without the trailing slash', async () => {
    const { store, commands: c } = commands();
    const outcome = await c.setApiOption({
      kind: 'OpenAiCompatible',
      field: 'baseUrl',
      value: 'http://localhost:11434/v1/',
    });
    expect(outcome).toMatchObject({ status: 'saved', feedback: null });
    expect((await store.load()).openAiCompatibleBaseUrl).toBe('http://localhost:11434/v1');
    await c.setApiOption({
      kind: 'OpenAiCompatible',
      field: 'baseUrl',
      value: 'https://openrouter.ai/api/v1',
    });
    expect((await store.load()).openAiCompatibleBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('refuses a base URL that is not http(s), or on an engine with a fixed endpoint', async () => {
    const { store, commands: c } = commands();
    for (const bad of ['ftp://host/v1', 'file:///C:/x', 'not a url', 'javascript:alert(1)']) {
      expect(
        await c.setApiOption({ kind: 'OpenAiCompatible', field: 'baseUrl', value: bad }),
      ).toEqual({ status: 'ignored', reason: 'invalid' });
    }
    expect(
      await c.setApiOption({ kind: 'OpenAi', field: 'baseUrl', value: 'https://evil.example' }),
    ).toEqual({ status: 'ignored', reason: 'invalid' });
    expect((await store.load()).openAiCompatibleBaseUrl).toBeNull();
  });
});
