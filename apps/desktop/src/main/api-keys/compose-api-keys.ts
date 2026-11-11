import path from 'node:path';
import type { ApiKeyStore } from '@vozella/core';
import { FakeApiKeyStore } from '@vozella/platform';
import { SafeStorageKeyStore, type StringCipher } from './safe-storage-key-store';

/** The key file under the app data root. Never in settings, never in the library. */
export const API_KEYS_FILE_NAME = 'api-keys.bin';

export interface ComposeApiKeysDeps {
  readonly fakeNative: boolean;
  readonly appDataDirectory: string;
  /** Electron `safeStorage`; only used outside the fake native build. */
  readonly cipher: StringCipher;
}

/**
 * The app's one API key store, shared by summaries, recording readiness, the Settings page and
 * the key channels. The fake native build keeps keys in memory, so e2e never touches the OS
 * keychain or writes a key file.
 */
export function composeApiKeys(deps: ComposeApiKeysDeps): ApiKeyStore {
  if (deps.fakeNative) return new FakeApiKeyStore();
  return new SafeStorageKeyStore({
    file: path.join(deps.appDataDirectory, API_KEYS_FILE_NAME),
    cipher: deps.cipher,
  });
}
