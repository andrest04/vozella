import { FakeApiKeyStore } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { composeApiKeys } from './compose-api-keys';
import { SafeStorageKeyStore } from './safe-storage-key-store';

const cipher = {
  isAsyncEncryptionAvailable: vi.fn(() => Promise.resolve(true)),
  encryptStringAsync: vi.fn((plain: string) => Promise.resolve(Buffer.from(plain))),
  decryptStringAsync: vi.fn((data: Buffer) =>
    Promise.resolve({ shouldReEncrypt: false, result: data.toString() }),
  ),
};

describe('composeApiKeys', () => {
  it('keeps keys in memory in the fake native build', () => {
    const store = composeApiKeys({ fakeNative: true, appDataDirectory: 'C:/app-data', cipher });
    expect(store).toBeInstanceOf(FakeApiKeyStore);
  });

  it('uses the safeStorage store otherwise, without touching the cipher yet', () => {
    const store = composeApiKeys({ fakeNative: false, appDataDirectory: 'C:/app-data', cipher });
    expect(store).toBeInstanceOf(SafeStorageKeyStore);
    expect(cipher.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
  });
});
