import {
  CancelSource,
  ManualSpeechTimer,
  readSettings,
  type ApiKeyStore,
  type ApiProviderError,
  type SpeechToTextRequest,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import { ScriptedLiveSockets } from '../fakes/scripted-live-socket';
import {
  createCloudSpeechToTextClient,
  createStreamingSpeechProvider,
} from './cloud-speech-factory';
import { DeepgramLiveSpeechProvider } from './deepgram-live-speech-provider';
import { DeepgramSpeechToTextClient } from './deepgram-speech-to-text-client';
import { OpenAiSpeechToTextClient } from './openai-speech-to-text-client';

const KEY = 'dg-factory-secret-0123456789';
const RATE = 16_000;

const chunk = (): SpeechToTextRequest => ({
  samples: new Float32Array(RATE).fill(0.25),
  sampleRate: RATE,
  language: 'es-US',
});

const DEEPGRAM_ANSWER = {
  metadata: { duration: 1 },
  results: { channels: [{ alternatives: [{ transcript: 'Hola.', words: [] }] }] },
};

const none = (): CancelSource['signal'] => new CancelSource().signal;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
};

describe('createCloudSpeechToTextClient: the adapter of each protocol', () => {
  it.each(['Groq', 'OpenAi'] as const)('builds the OpenAI-compatible client for %s', (kind) => {
    const made = createCloudSpeechToTextClient(
      { keys: new FakeApiKeyStore() },
      { kind, settings: readSettings({}) },
    );
    expect(made).toBeInstanceOf(OpenAiSpeechToTextClient);
  });

  it('builds the Deepgram prerecorded client, with its endpoint, model and stored key', async () => {
    const keys: ApiKeyStore = new FakeApiKeyStore({ Deepgram: KEY });
    const fake = new FakeFetch({ chunks: [JSON.stringify(DEEPGRAM_ANSWER)] });
    const made = createCloudSpeechToTextClient(
      { keys, fetch: fake.fetch },
      { kind: 'Deepgram', settings: readSettings({}) },
    );
    expect(made).toBeInstanceOf(DeepgramSpeechToTextClient);
    expect((await made.transcribe(chunk(), none())).text).toBe('Hola.');
    const call = fake.calls[0];
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(call?.headers.authorization).toBe(`Token ${KEY}`);
  });

  it('uses the model the caller saved for Deepgram instead of the default', async () => {
    const fake = new FakeFetch({ chunks: [JSON.stringify(DEEPGRAM_ANSWER)] });
    const made = createCloudSpeechToTextClient(
      { keys: new FakeApiKeyStore({ Deepgram: KEY }), fetch: fake.fetch },
      { kind: 'Deepgram', settings: readSettings({}), model: ' nova-2 ' },
    );
    await made.transcribe(chunk(), none());
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('model')).toBe('nova-2');
  });

  it('fails as KeyMissing for Deepgram without a stored key', async () => {
    const fake = new FakeFetch({});
    const made = createCloudSpeechToTextClient(
      { keys: new FakeApiKeyStore(), fetch: fake.fetch },
      { kind: 'Deepgram', settings: readSettings({}) },
    );
    await expect(made.transcribe(chunk(), none())).rejects.toMatchObject({
      kind: 'KeyMissing',
      displayName: 'Deepgram',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('createStreamingSpeechProvider', () => {
  const streaming = (reply: FakeHttpReply = {}, key: string | null = KEY) => {
    const sockets = new ScriptedLiveSockets();
    const fake = new FakeFetch(reply);
    const provider = createStreamingSpeechProvider(
      {
        keys: new FakeApiKeyStore(key === null ? {} : { Deepgram: key }),
        timer: new ManualSpeechTimer(),
        fetch: fake.fetch,
        socket: sockets.factory,
      },
      { kind: 'Deepgram', settings: readSettings({}) },
    );
    if (provider === null) throw new Error('Deepgram must stream');
    const closed: (ApiProviderError | null)[] = [];
    const heard: string[] = [];
    provider.open(
      { language: 'es-US', sampleRate: RATE, cancel: none() },
      {
        opened: () => heard.push('opened'),
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => closed.push(error),
      },
    );
    return { provider, sockets, fake, closed, heard };
  };

  it.each(['Groq', 'OpenAi'] as const)('has none for %s, whose text arrives in pieces', (kind) => {
    expect(
      createStreamingSpeechProvider(
        { keys: new FakeApiKeyStore(), timer: new ManualSpeechTimer() },
        { kind, settings: readSettings({}) },
      ),
    ).toBeNull();
  });

  it('builds the Deepgram live provider on its endpoint, with the default model and stored key', async () => {
    const { provider, sockets, heard } = streaming();
    await settle();
    expect(provider).toBeInstanceOf(DeepgramLiveSpeechProvider);
    expect(provider.displayName).toBe('Deepgram');
    const socket = sockets.sockets[0];
    const url = new URL(socket?.url ?? '');
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(socket?.headers).toEqual({ Authorization: `Token ${KEY}` });
    socket?.open();
    expect(heard).toEqual(['opened']);
  });

  it('fails as KeyMissing without a stored key', async () => {
    const { sockets, closed } = streaming({}, null);
    await settle();
    expect(sockets.sockets).toHaveLength(0);
    expect(closed[0]).toMatchObject({ kind: 'KeyMissing' });
  });

  it('asks the provider about the key when the socket never opens: a refused key is KeyInvalid', async () => {
    const { sockets, fake, closed } = streaming({
      status: 401,
      chunks: [`{"category":"UNAUTHORIZED","details":"${KEY}"}`],
    });
    await settle();
    sockets.sockets[0]?.fail();
    sockets.sockets[0]?.serverClose(1006);
    await settle();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: 'https://api.deepgram.com/v1/projects',
      method: 'GET',
      headers: { authorization: `Token ${KEY}` },
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ kind: 'KeyInvalid', displayName: 'Deepgram' });
    expect(closed[0]?.message).not.toContain(KEY);
  });

  it('reads an unreachable provider as Network, and an accepted key as a connection failure', async () => {
    const down = streaming({ networkError: true });
    await settle();
    down.sockets.sockets[0]?.serverClose(1006);
    await settle();
    expect(down.closed[0]).toMatchObject({ kind: 'Network' });

    const accepted = streaming({ chunks: ['{"projects":[]}'] });
    await settle();
    accepted.sockets.sockets[0]?.serverClose(1006);
    await settle();
    expect(accepted.fake.calls).toHaveLength(1);
    expect(accepted.closed[0]).toMatchObject({ kind: 'Network' });
  });
});
