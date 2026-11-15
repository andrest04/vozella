import { ApiProviderError } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import { apiJson, type ApiRequest } from './api-http';

const KEY = 'sk-test-secret-0123456789';

const call = (reply: FakeHttpReply, request: Partial<ApiRequest> = {}) => {
  const fake = new FakeFetch(reply);
  const run = (): Promise<unknown> =>
    apiJson(
      { url: 'https://api.example.test/v1/thing', method: 'POST', headers: {}, ...request },
      { fetch: fake.fetch, timeoutMs: 60_000, displayName: 'Engine', secret: KEY },
    );
  return { fake, run };
};

const failure = async (run: () => Promise<unknown>): Promise<ApiProviderError> =>
  run().then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as ApiProviderError,
  );

describe('apiJson with a JSON body', () => {
  it('sends the body as JSON text and parses the answer', async () => {
    const { fake, run } = call({ chunks: ['{"ok":', 'true}'] }, { body: { a: 1 } });
    expect(await run()).toEqual({ ok: true });
    expect(fake.calls[0]?.body).toEqual({ a: 1 });
    expect(fake.calls[0]?.form).toBeNull();
  });
});

describe('apiJson with a multipart form', () => {
  const form = (): FormData => {
    const data = new FormData();
    data.append('model', 'm');
    data.append('file', new Blob([Uint8Array.of(1, 2, 3)], { type: 'audio/wav' }), 'audio.wav');
    return data;
  };

  it('hands the form to fetch as it is, with no JSON body', async () => {
    const sent = form();
    const { fake, run } = call({ chunks: ['{"text":"hi"}'] }, { form: sent });
    expect(await run()).toEqual({ text: 'hi' });
    expect(fake.calls[0]?.form).toBe(sent);
    expect(fake.calls[0]?.body).toBeNull();
    expect(fake.calls[0]?.method).toBe('POST');
  });

  it('maps a failure like the JSON path and scrubs the key', async () => {
    const { run } = call({ status: 500, chunks: [`no: ${KEY}`] }, { form: form() });
    const error = await failure(run);
    expect(error).toBeInstanceOf(ApiProviderError);
    expect(error.kind).toBe('Unknown');
    expect(error.message).not.toContain(KEY);
  });

  it('times out when no byte arrives', async () => {
    const fake = new FakeFetch({ hang: true });
    const error = await failure(() =>
      apiJson(
        { url: 'https://api.example.test/v1/thing', method: 'POST', headers: {}, form: form() },
        { fetch: fake.fetch, timeoutMs: 20, displayName: 'Engine', secret: KEY },
      ),
    );
    expect(error.kind).toBe('TimedOut');
  });
});

describe('the retry-after of a failed request', () => {
  it('is kept in milliseconds for a rate limit', async () => {
    const { run } = call({ status: 429, chunks: ['slow down'], headers: { 'retry-after': '12' } });
    const error = await failure(run);
    expect(error.kind).toBe('RateLimited');
    expect(error.retryAfterMs).toBe(12_000);
  });

  it('is null without the header, and for any failure that is not a rate limit', async () => {
    expect(
      (await failure(call({ status: 429, chunks: ['slow down'] }).run)).retryAfterMs,
    ).toBeNull();
    const quota = call({
      status: 429,
      chunks: ['{"error":{"code":"insufficient_quota"}}'],
      headers: { 'retry-after': '12' },
    });
    expect((await failure(quota.run)).retryAfterMs).toBeNull();
    const down = call({ status: 503, chunks: ['down'], headers: { 'retry-after': '12' } });
    expect((await failure(down.run)).retryAfterMs).toBeNull();
  });
});

describe('apiJson with a raw body', () => {
  const audio = Uint8Array.of(82, 73, 70, 70, 0, 255);
  const raw = { bytes: { data: audio, contentType: 'audio/wav' } };

  it('sends the bytes as they are, with their content type beside the other headers', async () => {
    const { fake, run } = call(
      { chunks: ['{"ok":true}'] },
      { ...raw, headers: { authorization: 'Token abc' } },
    );
    expect(await run()).toEqual({ ok: true });
    expect(fake.calls[0]?.bytes).toEqual(audio);
    expect(fake.calls[0]?.headers).toEqual({
      authorization: 'Token abc',
      'content-type': 'audio/wav',
    });
    expect(fake.calls[0]?.body).toBeNull();
    expect(fake.calls[0]?.form).toBeNull();
    expect(fake.calls[0]?.method).toBe('POST');
  });

  it('records no bytes for a JSON body or a form', async () => {
    const { fake, run } = call({ chunks: ['{}'] }, { body: { a: 1 } });
    await run();
    expect(fake.calls[0]?.bytes).toBeNull();
  });

  it('maps a failure like the JSON path and scrubs the key', async () => {
    const { run } = call({ status: 401, chunks: [`bad key ${KEY}`] }, raw);
    const error = await failure(run);
    expect(error.kind).toBe('KeyInvalid');
    expect(error.message).not.toContain(KEY);
  });
});
