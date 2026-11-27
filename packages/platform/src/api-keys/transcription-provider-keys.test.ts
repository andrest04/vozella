import { describe, expect, it } from 'vitest';
import { ApiProviderError, TRANSCRIPTION_PROVIDERS, type ApiKeyStore } from '@vozella/core';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import {
  TranscriptionProviderKeys,
  verifyTranscriptionProviderKey,
} from './transcription-provider-keys';

const KEY = 'dg-secret-key-123';
const deepgram = TRANSCRIPTION_PROVIDERS.Deepgram;

/** The fake store through the port, which takes every kind that holds a key. */
const emptyStore = (): ApiKeyStore => new FakeApiKeyStore();

async function storeWithKey(): Promise<ApiKeyStore> {
  const keys = emptyStore();
  await keys.set('Deepgram', KEY);
  return keys;
}

const failure = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (error: unknown) => error,
  );

describe('verifyTranscriptionProviderKey', () => {
  it('asks Deepgram for the projects of the key, with the Token scheme', async () => {
    const fake = new FakeFetch({ chunks: ['{"projects":[]}'] });
    await verifyTranscriptionProviderKey(deepgram, ` ${KEY} `, fake.fetch);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: 'https://api.deepgram.com/v1/projects',
      method: 'GET',
      headers: { authorization: `Token ${KEY}` },
      body: null,
      form: null,
    });
  });

  it('asks ElevenLabs for a realtime Scribe token, with the bare key in its own header', async () => {
    const elevenLabs = TRANSCRIPTION_PROVIDERS.ElevenLabs;
    const fake = new FakeFetch({ chunks: ['{"token":"sutkn_test"}'] });
    await verifyTranscriptionProviderKey(elevenLabs, ` ${KEY} `, fake.fetch);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      method: 'POST',
      headers: { 'xi-api-key': KEY },
      body: null,
      form: null,
    });
    // No Authorization header: the key travels once, in the header the provider reads.
    expect(Object.keys(fake.calls[0]?.headers ?? {})).toEqual(['xi-api-key']);
  });

  it('reads an ElevenLabs refusal as KeyInvalid, without the key', async () => {
    const fake = new FakeFetch({
      status: 401,
      chunks: [`{"detail":{"status":"invalid_api_key","message":"${KEY}"}}`],
    });
    const error = await failure(
      verifyTranscriptionProviderKey(TRANSCRIPTION_PROVIDERS.ElevenLabs, KEY, fake.fetch),
    );
    expect(error).toMatchObject({ kind: 'KeyInvalid', displayName: 'ElevenLabs' });
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it.each([
    [{ status: 401, chunks: ['{"detail":{"status":"quota_exceeded","message":"m"}}'] }],
    [{ status: 402, chunks: ['{"detail":{"code":"insufficient_credits","message":"m"}}'] }],
  ] as const satisfies readonly (readonly [FakeHttpReply])[])(
    'reads a spent ElevenLabs credit (%j) as QuotaExceeded, not as a bad key',
    async (reply) => {
      const fake = new FakeFetch(reply);
      const error = await failure(
        verifyTranscriptionProviderKey(TRANSCRIPTION_PROVIDERS.ElevenLabs, KEY, fake.fetch),
      );
      expect(error).toMatchObject({ kind: 'QuotaExceeded', displayName: 'ElevenLabs' });
    },
  );

  it('keeps reading a Deepgram 401 as a bad key, whatever its body says', async () => {
    const fake = new FakeFetch({ status: 401, chunks: ['{"detail":{"status":"quota_exceeded"}}'] });
    const error = await failure(verifyTranscriptionProviderKey(deepgram, KEY, fake.fetch));
    expect(error).toMatchObject({ kind: 'KeyInvalid' });
  });

  it('accepts any 2xx answer, whatever its body', async () => {
    const fake = new FakeFetch({ status: 200, chunks: ['not json'] });
    await expect(
      verifyTranscriptionProviderKey(deepgram, KEY, fake.fetch),
    ).resolves.toBeUndefined();
  });

  it.each([null, '', '   '])(
    'fails as KeyMissing without a key (%j), before any request',
    async (key) => {
      const fake = new FakeFetch({});
      const error = await failure(verifyTranscriptionProviderKey(deepgram, key, fake.fetch));
      expect(error).toBeInstanceOf(ApiProviderError);
      expect(error).toMatchObject({ kind: 'KeyMissing', displayName: 'Deepgram' });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([
    [{ status: 401, chunks: ['{"err_code":"INVALID_AUTH"}'] }, 'KeyInvalid'],
    [{ status: 403 }, 'KeyInvalid'],
    [{ status: 402, chunks: ['{"err_code":"ASR_PAYMENT_REQUIRED"}'] }, 'QuotaExceeded'],
    [{ status: 429, chunks: ['{"err_code":"TOO_MANY_REQUESTS"}'] }, 'RateLimited'],
    [{ status: 500 }, 'Unknown'],
    [{ networkError: true }, 'Network'],
  ] as const satisfies readonly (readonly [FakeHttpReply, string])[])(
    'maps %j to %s, like every other API call',
    async (reply, kind) => {
      const fake = new FakeFetch(reply);
      const error = await failure(verifyTranscriptionProviderKey(deepgram, KEY, fake.fetch));
      expect(error).toBeInstanceOf(ApiProviderError);
      expect(error).toMatchObject({ kind, displayName: 'Deepgram' });
    },
  );

  it('fails as TimedOut when the provider does not answer', async () => {
    const fake = new FakeFetch({ hang: true });
    const error = await failure(
      verifyTranscriptionProviderKey(deepgram, KEY, fake.fetch, { timeoutMs: 5 }),
    );
    expect(error).toMatchObject({ kind: 'TimedOut' });
  });

  it('never keeps the key in a failure', async () => {
    const fake = new FakeFetch({ status: 401, chunks: [`bad credentials: ${KEY}`] });
    const error = await failure(verifyTranscriptionProviderKey(deepgram, KEY, fake.fetch));
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect((error as Error).message).not.toContain(KEY);
    expect(String((error as ApiProviderError).detail)).not.toContain(KEY);
  });
});

describe('TranscriptionProviderKeys', () => {
  const service = (keys: ApiKeyStore | undefined, reply: FakeHttpReply = {}) => {
    const fake = new FakeFetch(reply);
    return { fake, keys: new TranscriptionProviderKeys({ keys, fetch: fake.fetch }) };
  };

  it('saves the key trimmed and answers only that one is set', async () => {
    const store = emptyStore();
    const answer = await service(store).keys.set('Deepgram', `  ${KEY}  `);
    expect(answer).toEqual({ status: 'saved', keySet: true });
    expect(await store.get('Deepgram')).toBe(KEY);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it('a blank key removes the saved one', async () => {
    const store = await storeWithKey();
    expect(await service(store).keys.set('Deepgram', '   ')).toEqual({
      status: 'saved',
      keySet: false,
    });
    expect(await store.has('Deepgram')).toBe(false);
  });

  it('removes the key', async () => {
    const store = await storeWithKey();
    expect(await service(store).keys.clear('Deepgram')).toEqual({ status: 'saved', keySet: false });
    expect(await store.get('Deepgram')).toBeNull();
  });

  it('keeps the keys of the API engines apart', async () => {
    const store = await storeWithKey();
    await store.set('Groq', 'gsk-other');
    await service(store).keys.clear('Deepgram');
    expect(await store.get('Groq')).toBe('gsk-other');
  });

  it('without a store nothing can be saved, and there is nothing to remove', async () => {
    const { keys } = service(undefined);
    expect(await keys.set('Deepgram', KEY)).toEqual({
      status: 'failed',
      errorKey: 'Ui_ApiKeyStoreUnavailable',
    });
    expect(await keys.clear('Deepgram')).toEqual({ status: 'saved', keySet: false });
  });

  it('a store that cannot encrypt answers with the reason, never the key', async () => {
    const broken: ApiKeyStore = {
      has: () => Promise.resolve(false),
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error(`cannot encrypt ${KEY}`)),
      delete: () => Promise.reject(new Error('cannot write')),
    };
    const { keys } = service(broken);
    const saved = await keys.set('Deepgram', KEY);
    expect(saved).toEqual({ status: 'failed', errorKey: 'Ui_ApiKeyStoreUnavailable' });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(await keys.clear('Deepgram')).toEqual({
      status: 'failed',
      errorKey: 'Ui_ApiKeyStoreUnavailable',
    });
  });

  it('verifies the saved key against the provider', async () => {
    const { fake, keys } = service(await storeWithKey(), { chunks: ['{"projects":[]}'] });
    expect(await keys.verify('Deepgram')).toEqual({ status: 'verified' });
    expect(fake.calls[0]?.headers.authorization).toBe(`Token ${KEY}`);
  });

  it('verifies the saved ElevenLabs key with its own request', async () => {
    const store = emptyStore();
    await store.set('ElevenLabs', KEY);
    const { fake, keys } = service(store, { chunks: ['{"token":"sutkn_test"}'] });
    expect(await keys.verify('ElevenLabs')).toEqual({ status: 'verified' });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      method: 'POST',
      headers: { 'xi-api-key': KEY },
    });
  });

  it('a rejected key is KeyInvalid, and no saved key is KeyMissing without a request', async () => {
    const rejected = service(await storeWithKey(), { status: 401 });
    expect(await rejected.keys.verify('Deepgram')).toEqual({
      status: 'failed',
      errorKey: 'Ui_ApiKeyInvalid',
    });
    const missing = service(emptyStore());
    expect(await missing.keys.verify('Deepgram')).toEqual({
      status: 'failed',
      errorKey: 'Ui_ApiKeyMissing',
    });
    expect(missing.fake.calls).toHaveLength(0);
    expect(await service(undefined).keys.verify('Deepgram')).toEqual({
      status: 'failed',
      errorKey: 'Ui_ApiKeyMissing',
    });
  });

  it('a failure that is not about the key keeps its own reason', async () => {
    const { keys } = service(await storeWithKey(), { networkError: true });
    expect(await keys.verify('Deepgram')).toEqual({ status: 'failed', errorKey: 'Ui_ApiNetwork' });
  });
});
