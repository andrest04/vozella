import type { ApiKeyKind, ApiKeyStore } from '@vozella/core';

/**
 * Fake: keys held in memory, for unit tests and the fake native build. Never on disk. Like the real
 * store it takes every kind that holds a key: the API engines and the transcription-only providers.
 */
export class FakeApiKeyStore implements ApiKeyStore {
  private readonly keys = new Map<ApiKeyKind, string>();

  constructor(initial: Partial<Record<ApiKeyKind, string>> = {}) {
    for (const [kind, key] of Object.entries(initial) as [ApiKeyKind, string][]) {
      this.keys.set(kind, key);
    }
  }

  has(kind: ApiKeyKind): Promise<boolean> {
    return Promise.resolve(this.keys.has(kind));
  }

  get(kind: ApiKeyKind): Promise<string | null> {
    return Promise.resolve(this.keys.get(kind) ?? null);
  }

  set(kind: ApiKeyKind, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === '') this.keys.delete(kind);
    else this.keys.set(kind, trimmed);
    return Promise.resolve();
  }

  delete(kind: ApiKeyKind): Promise<void> {
    this.keys.delete(kind);
    return Promise.resolve();
  }
}
