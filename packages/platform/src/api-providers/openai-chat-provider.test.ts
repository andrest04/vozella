import { ApiProviderError, CancelSource, isCancellation, type PromptOutcome } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import { OpenAiChatProvider } from './openai-chat-provider';

const KEY = 'sk-test-secret-0123456789';

const delta = (content: string, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;

function provider(reply: FakeHttpReply, apiKey: string | null = KEY, timeoutMs = 60_000) {
  const fake = new FakeFetch(reply);
  const made = new OpenAiChatProvider({
    providerId: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    apiKey,
    fetch: fake.fetch,
    timeoutMs,
  });
  return { fake, made };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

const failure = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );

describe('OpenAiChatProvider', () => {
  it('posts a streaming chat request with the bearer key and the model', async () => {
    const { fake, made } = provider({ chunks: [delta('Hello'), 'data: [DONE]\n\n'] });
    await made.completePrompt('the prompt', new CancelSource().signal);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      messages: [{ role: 'user', content: 'the prompt' }],
    });
  });

  it('sends no authorization header when there is no key (compatible local servers)', async () => {
    const { fake, made } = provider({ chunks: [delta('ok'), 'data: [DONE]\n\n'] }, null);
    await made.completePrompt('p', new CancelSource().signal);
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('streams the content deltas even when an SSE line is split across reads', async () => {
    const whole = delta('Hel') + delta('lo') + 'data: [DONE]\n\n';
    const { made } = provider({
      chunks: [whole.slice(0, 17), whole.slice(17, 50), whole.slice(50)],
    });
    const pieces = await collect(made.streamPrompt('p', new CancelSource().signal));
    expect(pieces.join('')).toBe('Hello');
  });

  it('reports a cut answer when the finish reason is length', async () => {
    const outcomes: PromptOutcome[] = [];
    const { made } = provider({ chunks: [delta('part', 'length'), 'data: [DONE]\n\n'] });
    const text = await made.completePrompt('p', new CancelSource().signal, {
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(text).toBe('part');
    expect(outcomes).toEqual([{ truncated: true }]);
  });

  it('reports a whole answer as not truncated on the streaming path', async () => {
    const outcomes: PromptOutcome[] = [];
    const { made } = provider({ chunks: [delta('done', 'stop'), 'data: [DONE]\n\n'] });
    await collect(
      made.streamPrompt('p', new CancelSource().signal, {
        onOutcome: (outcome) => outcomes.push(outcome),
      }),
    );
    expect(outcomes).toEqual([{ truncated: false }]);
  });

  it('builds the summary from the full prompt in one request', async () => {
    const reply = '## Summary\nThe team met.';
    const { fake, made } = provider({ chunks: [delta(reply), 'data: [DONE]\n\n'] });
    const result = await made.summarize(
      {
        transcript: 'Alice: hello',
        title: 'Weekly',
        recordedAt: { ms: Date.UTC(2026, 0, 5, 10), offsetMinutes: 0, fraction: '0000000' },
        outputLanguage: 'en',
      },
      new CancelSource().signal,
    );
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(fake.calls[0]?.body)).toContain('Alice: hello');
    expect(result.providerId).toBe('openai');
    expect(result.summaryMarkdown).toContain('The team met.');
  });

  it.each([
    [401, '', 'KeyInvalid'],
    [429, '{"error":{"code":"rate_limit_exceeded"}}', 'RateLimited'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'QuotaExceeded'],
    [404, '', 'ModelNotFound'],
    [500, 'boom', 'Unknown'],
  ])('maps HTTP %i to %s', async (status, body, kind) => {
    const { made } = provider({ status, chunks: [body] });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe(kind);
  });

  it('never puts the key in the error message', async () => {
    const { made } = provider({ status: 500, chunks: [`bad key ${KEY}`] });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect((error as Error).message).not.toContain(KEY);
    expect(String((error as ApiProviderError).detail)).not.toContain(KEY);
  });

  it('maps a failed connection to Network', async () => {
    const { made } = provider({ networkError: true });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect((error as ApiProviderError).kind).toBe('Network');
  });

  it('maps an idle request to TimedOut', async () => {
    const { made } = provider({ hang: true }, KEY, 20);
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect((error as ApiProviderError).kind).toBe('TimedOut');
  });

  it('maps an answer with no text to EmptyOutput', async () => {
    const { made } = provider({ chunks: [delta('  '), 'data: [DONE]\n\n'] });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect((error as ApiProviderError).kind).toBe('EmptyOutput');
  });

  it('turns an error event in the stream into a provider error', async () => {
    const { made } = provider({ chunks: ['data: {"error":{"message":"model overloaded"}}\n\n'] });
    const error = await failure(() => collect(made.streamPrompt('p', new CancelSource().signal)));
    expect((error as ApiProviderError).kind).toBe('Unknown');
    expect((error as ApiProviderError).detail).toContain('model overloaded');
  });

  it('rejects with a cancellation when cancelled mid-stream', async () => {
    const cancel = new CancelSource();
    const { made } = provider({ chunks: [delta('first')], hang: true });
    const pieces: string[] = [];
    const error = await failure(async () => {
      for await (const piece of made.streamPrompt('p', cancel.signal)) {
        pieces.push(piece);
        cancel.cancel();
      }
    });
    expect(pieces).toEqual(['first']);
    expect(isCancellation(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiProviderError);
  });

  it('rejects at once when already cancelled', async () => {
    const cancel = new CancelSource();
    cancel.cancel();
    const { fake, made } = provider({ chunks: [delta('x')] });
    const error = await failure(() => made.completePrompt('p', cancel.signal));
    expect(isCancellation(error)).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});
