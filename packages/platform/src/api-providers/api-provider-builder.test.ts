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

  it('builds Groq on the OpenAI protocol with its own key, endpoint and a prefixed model id', async () => {
    const keys = new FakeApiKeyStore({ Groq: 'gsk-key', OpenAi: 'sk-other' });
    const fake = new FakeFetch({ chunks: okStream });
    const build = createApiProviderBuilder({ keys, fetch: fake.fetch });
    const made = await build(
      API_ENGINES.Groq,
      readSettings({ SelectedGroqModelId: 'openai/gpt-oss-120b' }),
    );
    expect(made).toBeInstanceOf(OpenAiChatProvider);
    expect(made.id).toBe('groq');
    await made.completePrompt('p', new CancelSource().signal);
    expect(fake.calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer gsk-key');
    expect(fake.calls[0]?.body).toMatchObject({ model: 'openai/gpt-oss-120b' });
  });

  it('answers a summary and a chat prompt through Groq with its default model', async () => {
    const keys = new FakeApiKeyStore({ Groq: 'gsk-key' });
    const fake = new FakeFetch({ chunks: okStream });
    const build = createApiProviderBuilder({ keys, fetch: fake.fetch });
    const made = await build(API_ENGINES.Groq, readSettings({}));
    const cancel = new CancelSource().signal;
    expect(await made.completePrompt('Summarize the meeting.', cancel)).toBe('ok');
    let streamed = '';
    for await (const chunk of made.streamPrompt('What was decided?', cancel)) streamed += chunk;
    expect(streamed).toBe('ok');
    expect(fake.calls.map((call) => call.url)).toEqual([
      'https://api.groq.com/openai/v1/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
    ]);
    expect(fake.calls[1]?.body).toMatchObject({ model: 'llama-3.3-70b-versatile' });
  });

  it('fails with KeyMissing for Groq when only another engine has a key', async () => {
    const build = createApiProviderBuilder({ keys: new FakeApiKeyStore({ OpenAi: 'sk-other' }) });
    const error = await failure(async () => build(API_ENGINES.Groq, readSettings({})));
    expect((error as ApiProviderError).kind).toBe('KeyMissing');
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

  it('keeps only chat models that are not being retired for OpenAI and Gemini', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'gpt-6-astra', shutdown_date: null },
        { id: 'gpt-6-luna' },
        { id: 'gpt-5-mini', shutdown_date: '2026-12-11' },
        { id: 'text-embedding-3-small', shutdown_date: null },
        { id: 'gpt-image-2.6-flare' },
        { id: 'gpt-realtime-2.1' },
      ],
    });
    const openAi = await listApiModels(
      API_ENGINES.OpenAi,
      readSettings({}),
      'k',
      new FakeFetch({ chunks: [body] }).fetch,
    );
    expect(openAi).toEqual(['gpt-6-astra', 'gpt-6-luna']);
    const gemini = await listApiModels(
      API_ENGINES.Gemini,
      readSettings({}),
      'k',
      new FakeFetch({
        chunks: [
          JSON.stringify({
            data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-embedding-2' }],
          }),
        ],
      }).fetch,
    );
    expect(gemini).toEqual(['gemini-3.8-flash']);
  });

  it('lists the Groq chat models with their vendor prefix kept, without speech or safety models', async () => {
    const fake = new FakeFetch({
      chunks: [
        JSON.stringify({
          data: [
            { id: 'openai/gpt-oss-120b' },
            { id: 'llama-3.3-70b-versatile' },
            { id: 'whisper-large-v3-turbo' },
            { id: 'meta-llama/llama-prompt-guard-2-86m' },
            { id: 'canopylabs/orpheus-v1-english' },
            { id: 'qwen/qwen3.8-27b' },
          ],
        }),
      ],
    });
    const ids = await listApiModels(API_ENGINES.Groq, readSettings({}), 'gsk-key', fake.fetch);
    // Only the Gemini `models/` prefix is stripped: a vendor prefix is part of the id Groq takes.
    expect(ids).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(fake.calls[0]?.url).toBe('https://api.groq.com/openai/v1/models');
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer gsk-key');
  });

  it('lists every model of an OpenAI-compatible server unfiltered', async () => {
    const ids = await listApiModels(
      API_ENGINES.OpenAiCompatible,
      readSettings({ OpenAiCompatibleBaseUrl: 'http://localhost:11434/v1' }),
      null,
      new FakeFetch({
        chunks: [JSON.stringify({ data: [{ id: 'llama3.1' }, { id: 'nomic-embed-text' }] })],
      }).fetch,
    );
    expect(ids).toEqual(['llama3.1', 'nomic-embed-text']);
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
