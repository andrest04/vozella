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
