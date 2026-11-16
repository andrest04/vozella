import { describe, expect, it } from 'vitest';
import { FakeApiKeyStore } from './fake-api-key-store';

describe('FakeApiKeyStore', () => {
  it('saves, reads and deletes keys per kind', async () => {
    const store = new FakeApiKeyStore({ Anthropic: 'a' });
    expect(await store.has('Anthropic')).toBe(true);
    expect(await store.has('OpenAi')).toBe(false);
    await store.set('OpenAi', 'o');
    expect(await store.get('OpenAi')).toBe('o');
    await store.delete('Anthropic');
    expect(await store.get('Anthropic')).toBeNull();
  });
});

describe('FakeApiKeyStore with a transcription-only provider', () => {
  it('holds the key of every kind the key store takes', async () => {
    const store = new FakeApiKeyStore({ Deepgram: 'd', Groq: 'g' });
    expect(await store.get('Deepgram')).toBe('d');
    await store.set('Deepgram', ' d2 ');
    expect(await store.get('Deepgram')).toBe('d2');
    await store.delete('Deepgram');
    expect(await store.has('Deepgram')).toBe(false);
    expect(await store.get('Groq')).toBe('g');
  });
});
