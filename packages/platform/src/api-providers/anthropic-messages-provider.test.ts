import { ApiProviderError, CancelSource, isCancellation, type PromptOutcome } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import { AnthropicMessagesProvider } from './anthropic-messages-provider';

const KEY = 'sk-ant-test-secret-0123456789';

const event = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const text = (value: string): string =>
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } });
const stop = (reason: string): string =>
  event('message_delta', { delta: { stop_reason: reason } }) + event('message_stop', {});

function provider(reply: FakeHttpReply) {
  const fake = new FakeFetch(reply);
  const made = new AnthropicMessagesProvider({
    providerId: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.example.test/v1',
    model: 'claude-test',
    apiKey: KEY,
    fetch: fake.fetch,
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

describe('AnthropicMessagesProvider', () => {
  it('posts a streaming messages request with the key and version headers', async () => {
    const { fake, made } = provider({ chunks: [text('Hi'), stop('end_turn')] });
    await made.completePrompt('the prompt', new CancelSource().signal);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://api.example.test/v1/messages');
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-api-key']).toBe(KEY);
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.body).toMatchObject({
      model: 'claude-test',
      stream: true,
      messages: [{ role: 'user', content: 'the prompt' }],
    });
    expect((call?.body as { max_tokens: number }).max_tokens).toBeGreaterThan(0);
  });

  it('streams the text deltas across split reads and skips other events', async () => {
    const whole =
      event('message_start', { message: {} }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      text('Hel') +
      event('ping', {}) +
      text('lo') +
      stop('end_turn');
    const { made } = provider({
      chunks: [whole.slice(0, 40), whole.slice(40, 151), whole.slice(151)],
    });
    expect((await collect(made.streamPrompt('p', new CancelSource().signal))).join('')).toBe(
      'Hello',
    );
  });

  it('reports a cut answer when the stop reason is max_tokens', async () => {
    const outcomes: PromptOutcome[] = [];
    const { made } = provider({ chunks: [text('part'), stop('max_tokens')] });
    await made.completePrompt('p', new CancelSource().signal, {
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(outcomes).toEqual([{ truncated: true }]);
  });

  it('reports a finished answer as not truncated', async () => {
    const outcomes: PromptOutcome[] = [];
    const { made } = provider({ chunks: [text('all'), stop('end_turn')] });
    await made.completePrompt('p', new CancelSource().signal, {
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(outcomes).toEqual([{ truncated: false }]);
  });

  it.each([
    ['rate_limit_error', 'RateLimited'],
    ['authentication_error', 'KeyInvalid'],
    ['not_found_error', 'ModelNotFound'],
    ['overloaded_error', 'Unknown'],
  ])('maps an %s event to %s', async (type, kind) => {
    const { made } = provider({
      chunks: [text('a'), event('error', { error: { type, message: 'went wrong' } })],
    });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe(kind);
  });

  it('maps HTTP 401 to KeyInvalid', async () => {
    const { made } = provider({ status: 401, chunks: ['{"type":"error"}'] });
    const error = await failure(() => made.completePrompt('p', new CancelSource().signal));
    expect((error as ApiProviderError).kind).toBe('KeyInvalid');
  });

  it('maps an answer with no text to EmptyOutput', async () => {
    const { made } = provider({ chunks: [stop('end_turn')] });
    const error = await failure(() => collect(made.streamPrompt('p', new CancelSource().signal)));
    expect((error as ApiProviderError).kind).toBe('EmptyOutput');
  });

  it('rejects with a cancellation when cancelled while waiting', async () => {
    const cancel = new CancelSource();
    const { made } = provider({ hang: true });
    const pending = made.completePrompt('p', cancel.signal);
    cancel.cancel();
    expect(isCancellation(await failure(() => pending))).toBe(true);
  });
});
