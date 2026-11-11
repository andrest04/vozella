import type { ApiProviderKind } from '../library/settings';

/**
 * Port: the user's API keys for the BYOK engines, one per API kind. The adapter encrypts them at
 * rest and lives in the main process; keys never enter settings, logs, the library or the
 * renderer, which only learns whether a key is set (`has`).
 */
export interface ApiKeyStore {
  has(kind: ApiProviderKind): Promise<boolean>;
  /** The key, or null when none is saved. */
  get(kind: ApiProviderKind): Promise<string | null>;
  set(kind: ApiProviderKind, key: string): Promise<void>;
  delete(kind: ApiProviderKind): Promise<void>;
}
