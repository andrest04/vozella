import type { ApiKeyStore, ApiProviderKind } from '@vozella/core';

/** Fake: API keys held in memory, for unit tests and the fake native build. Never on disk. */
export class FakeApiKeyStore implements ApiKeyStore {
  private readonly keys = new Map<ApiProviderKind, string>();

  constructor(initial: Partial<Record<ApiProviderKind, string>> = {}) {
    for (const [kind, key] of Object.entries(initial) as [ApiProviderKind, string][]) {
      this.keys.set(kind, key);
    }
  }

  has(kind: ApiProviderKind): Promise<boolean> {
    return Promise.resolve(this.keys.has(kind));
  }

  get(kind: ApiProviderKind): Promise<string | null> {
    return Promise.resolve(this.keys.get(kind) ?? null);
  }

  set(kind: ApiProviderKind, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === '') this.keys.delete(kind);
    else this.keys.set(kind, trimmed);
    return Promise.resolve();
  }

  delete(kind: ApiProviderKind): Promise<void> {
    this.keys.delete(kind);
    return Promise.resolve();
  }
}
