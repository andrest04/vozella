import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeStorageKeyStore, type StringCipher } from './safe-storage-key-store';

/** Reversible stand-in for Electron `safeStorage`: no OS keychain is touched. */
function fakeCipher(available = true): StringCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`),
    decryptString: (data) => {
      const text = data.toString();
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext');
      return Buffer.from(text.slice(4), 'hex').toString();
    },
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-api-keys-test-'));
  file = path.join(dir, 'api-keys.bin');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SafeStorageKeyStore', () => {
  it('keeps keys across instances, encrypted on disk', async () => {
    const first = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    await first.set('OpenAi', 'sk-secret-value');
    await first.set('Anthropic', 'sk-ant-other');

    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('sk-secret-value');

    const second = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    expect(await second.get('OpenAi')).toBe('sk-secret-value');
    expect(await second.has('Anthropic')).toBe(true);
    expect(await second.has('Gemini')).toBe(false);
    expect(await second.get('Gemini')).toBeNull();
  });

  it('trims the key and deletes it', async () => {
    const store = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    await store.set('Gemini', '  g-key \n');
    expect(await store.get('Gemini')).toBe('g-key');
    await store.delete('Gemini');
    expect(await store.has('Gemini')).toBe(false);
    expect(await new SafeStorageKeyStore({ file, cipher: fakeCipher() }).has('Gemini')).toBe(false);
  });

  it('treats a blank key as a delete', async () => {
    const store = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    await store.set('OpenAi', 'k');
    await store.set('OpenAi', '   ');
    expect(await store.has('OpenAi')).toBe(false);
  });

  it('refuses to save when encryption is unavailable and reports no key', async () => {
    const store = new SafeStorageKeyStore({ file, cipher: fakeCipher(false) });
    await expect(store.set('OpenAi', 'k')).rejects.toThrow(/encryption is not available/i);
    expect(await store.has('OpenAi')).toBe(false);
    expect(await store.get('OpenAi')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reads an unreadable file as no keys and replaces it on the next save', async () => {
    fs.writeFileSync(file, 'not encrypted at all');
    const store = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    expect(await store.has('OpenAi')).toBe(false);
    await store.set('OpenAi', 'k');
    expect(await new SafeStorageKeyStore({ file, cipher: fakeCipher() }).get('OpenAi')).toBe('k');
  });

  it('serializes concurrent saves so none is lost', async () => {
    const store = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    await Promise.all([
      store.set('OpenAi', 'o'),
      store.set('Anthropic', 'a'),
      store.set('Gemini', 'g'),
    ]);
    const reread = new SafeStorageKeyStore({ file, cipher: fakeCipher() });
    expect(await reread.get('OpenAi')).toBe('o');
    expect(await reread.get('Anthropic')).toBe('a');
    expect(await reread.get('Gemini')).toBe('g');
  });
});
