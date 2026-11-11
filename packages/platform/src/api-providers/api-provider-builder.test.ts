import { API_ENGINES, ApiProviderError, CancelSource, readSettings } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeFetch } from '../fakes/fake-fetch';
import { AnthropicMessagesProvider } from './anthropic-messages-provider';
import { createApiProviderBuilder } from './api-provider-builder';
import { listApiModels } from './list-models';
import { OpenAiChatProvider } from './openai-chat-provider';

const failure = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );

const okStream = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'];

describe('createApiProviderBuilder', () => {
  it('builds the OpenAI protocol provider with the saved key, model and base URL', async () => {
    const keys = new FakeApiKeyStore({ Gemini: 'g-key' });
    const fake = new FakeFetch({ chunks: okStream });
    const build = createApiProviderBuilder({ keys, fetch: fake.fetch });
    const made = await build(
      API_ENGINES.Gemini,
      readSettings({ SelectedGeminiModelId: 'gemini-x' }),
    );
    expect(made).toBeInstanceOf(OpenAiChatProvider);
    expect(made.id).toBe('gemini');
    await made.completePrompt('p', new CancelSource().signal);
    expect(fake.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer g-key');
    expect(fake.calls[0]?.body).toMatchObject({ model: 'gemini-x' });
  });

  it('builds the Anthropic protocol provider', async () => {
    const keys = new FakeApiKeyStore({ Anthropic: 'a-key' });
    const build = createApiProviderBuilder({ keys, fetch: new FakeFetch({}).fetch });
    expect(await build(API_ENGINES.Anthropic, readSettings({}))).toBeInstanceOf(
      AnthropicMessagesProvider,
    );
  });

  it('fails with KeyMissing when a required key is not saved', async () => {
    const build = createApiProviderBuilder({ keys: new FakeApiKeyStore() });
    const error = await failure(async () => build(API_ENGINES.OpenAi, readSettings({})));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe('KeyMissing');
  });

  it('builds the compatible kind without a key', async () => {
    const fake = new FakeFetch({ chunks: okStream });
    const build = createApiProviderBuilder({ keys: new FakeApiKeyStore(), fetch: fake.fetch });
    const made = await build(
      API_ENGINES.OpenAiCompatible,
      readSettings({
        OpenAiCompatibleBaseUrl: 'http://localhost:11434/v1/',
        SelectedOpenAiCompatibleModelId: 'llama3',
      }),
    );
    await made.completePrompt('p', new CancelSource().signal);
    expect(fake.calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe('listApiModels', () => {
  it('lists the OpenAI protocol models sorted, without the Gemini models/ prefix', async () => {
    const fake = new FakeFetch({
      chunks: [JSON.stringify({ data: [{ id: 'models/b' }, { id: 'a' }, { id: 'c' }] })],
    });
    const ids = await listApiModels(API_ENGINES.Gemini, readSettings({}), 'g-key', fake.fetch);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(fake.calls[0]?.method).toBe('GET');
    expect(fake.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer g-key');
  });

  it('lists the Anthropic models with the key and version headers', async () => {
    const fake = new FakeFetch({
      chunks: [JSON.stringify({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] })],
    });
    const ids = await listApiModels(API_ENGINES.Anthropic, readSettings({}), 'a-key', fake.fetch);
    expect(ids).toEqual(['claude-a', 'claude-b']);
    expect(fake.calls[0]?.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(fake.calls[0]?.headers['x-api-key']).toBe('a-key');
    expect(fake.calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('maps a rejected key to KeyInvalid', async () => {
    const fake = new FakeFetch({ status: 401, chunks: ['{}'] });
    const error = await failure(() =>
      listApiModels(API_ENGINES.OpenAi, readSettings({}), 'bad', fake.fetch),
    );
    expect((error as ApiProviderError).kind).toBe('KeyInvalid');
  });

  it('maps an unreachable host to Network', async () => {
    const fake = new FakeFetch({ networkError: true });
    const error = await failure(() =>
      listApiModels(
        API_ENGINES.OpenAiCompatible,
        readSettings({ OpenAiCompatibleBaseUrl: 'http://localhost:1234/v1' }),
        null,
        fake.fetch,
      ),
    );
    expect((error as ApiProviderError).kind).toBe('Network');
  });

  it('fails with KeyMissing when a required key is absent', async () => {
    const error = await failure(() =>
      listApiModels(API_ENGINES.OpenAi, readSettings({}), null, new FakeFetch({}).fetch),
    );
    expect((error as ApiProviderError).kind).toBe('KeyMissing');
  });
});
