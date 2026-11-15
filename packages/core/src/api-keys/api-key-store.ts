import type { ApiProviderKind } from '../library/settings';
import type { TranscriptionProviderKind } from '../settings/transcription-provider-table';

/**
 * Every kind a key is stored under: an API engine (summaries and chat, and transcription where
 * the provider offers it) or a transcription-only provider.
 */
export type ApiKeyKind = ApiProviderKind | TranscriptionProviderKind;

/**
 * Port: the user's API keys (BYOK), one per kind. The adapter encrypts them at rest and lives in
 * the main process; keys never enter settings, logs, the library or the renderer, which only
 * learns whether a key is set (`has`).
 */
export interface ApiKeyStore {
  has(kind: ApiKeyKind): Promise<boolean>;
  /** The key, or null when none is saved. */
  get(kind: ApiKeyKind): Promise<string | null>;
  set(kind: ApiKeyKind, key: string): Promise<void>;
  delete(kind: ApiKeyKind): Promise<void>;
}
