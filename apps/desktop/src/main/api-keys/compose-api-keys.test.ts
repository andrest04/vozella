import { FakeApiKeyStore } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { composeApiKeys } from './compose-api-keys';
import { SafeStorageKeyStore } from './safe-storage-key-store';

const cipher = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plain: string) => Buffer.from(plain)),
  decryptString: vi.fn((data: Buffer) => data.toString()),
};

describe('composeApiKeys', () => {
  it('keeps keys in memory in the fake native build', () => {
    const store = composeApiKeys({ fakeNative: true, appDataDirectory: 'C:/app-data', cipher });
    expect(store).toBeInstanceOf(FakeApiKeyStore);
  });

  it('uses the safeStorage store otherwise, without touching the cipher yet', () => {
    const store = composeApiKeys({ fakeNative: false, appDataDirectory: 'C:/app-data', cipher });
    expect(store).toBeInstanceOf(SafeStorageKeyStore);
    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled();
  });
});
