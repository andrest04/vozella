import fs from 'node:fs/promises';
import type { ApiKeyStore, ApiProviderKind } from '@vozella/core';
import { writeFileAtomic } from '@vozella/platform';

/** The async part of Electron `safeStorage` the store uses, so tests run without Electron. */
export interface StringCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export interface SafeStorageKeyStoreDeps {
  /** `<app data>\api-keys.bin`: base64 of the encrypted JSON map of kind to key. */
  readonly file: string;
  readonly cipher: StringCipher;
}

type KeyMap = Partial<Record<ApiProviderKind, string>>;

const isKeyMap = (value: unknown): value is KeyMap =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((key) => typeof key === 'string');

/**
 * `ApiKeyStore` on Electron `safeStorage` (DPAPI on Windows): every key is encrypted at rest in
 * one file under the app data root and held decrypted only in this process. Writes are atomic and
 * serialized. Without OS encryption nothing is saved (`set` throws) and no key reads as set, so
 * a key is never written in plain text. A file that cannot be decrypted (another Windows user, a
 * damaged file) reads as no keys and is replaced on the next save. When the OS reports a rotated
 * key (`shouldReEncrypt`), the file is rewritten with the current one.
 */
export class SafeStorageKeyStore implements ApiKeyStore {
  private cache: Promise<KeyMap> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SafeStorageKeyStoreDeps) {}

  async has(kind: ApiProviderKind): Promise<boolean> {
    return (await this.get(kind)) !== null;
  }

  async get(kind: ApiProviderKind): Promise<string | null> {
    if (!(await this.deps.cipher.isAsyncEncryptionAvailable())) return null;
    const key = (await this.load())[kind];
    return key === undefined || key === '' ? null : key;
  }

  async set(kind: ApiProviderKind, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === '') return this.delete(kind);
    if (!(await this.deps.cipher.isAsyncEncryptionAvailable())) {
      throw new Error('OS encryption is not available, so the API key cannot be saved securely.');
    }
    return this.update((keys) => ({ ...keys, [kind]: trimmed }));
  }

  async delete(kind: ApiProviderKind): Promise<void> {
    if (!(await this.deps.cipher.isAsyncEncryptionAvailable())) return;
    return this.update((keys) => {
      return Object.fromEntries(Object.entries(keys).filter(([saved]) => saved !== kind));
    });
  }

  /** Resolves once every pending write, including a re-encryption, has reached the disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  private load(): Promise<KeyMap> {
    this.cache ??= this.readFile();
    return this.cache;
  }

  private async readFile(): Promise<KeyMap> {
    let text: string;
    try {
      text = await fs.readFile(this.deps.file, 'utf8');
    } catch {
      return {};
    }
    try {
      const { shouldReEncrypt, result } = await this.deps.cipher.decryptStringAsync(
        Buffer.from(text.trim(), 'base64'),
      );
      const json: unknown = JSON.parse(result);
      if (!isKeyMap(json)) return {};
      // Not awaited: `update` waits on the cache this read is filling. A failed rewrite keeps
      // the old file, which still decrypts.
      if (shouldReEncrypt) void this.update((keys) => keys).catch(() => undefined);
      return json;
    } catch {
      return {};
    }
  }

  /** One write at a time, each from the latest map, so parallel saves never lose a key. */
  private update(change: (keys: KeyMap) => KeyMap): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(await this.load());
      const encrypted = await this.deps.cipher.encryptStringAsync(JSON.stringify(next));
      await writeFileAtomic(this.deps.file, encrypted.toString('base64'));
      this.cache = Promise.resolve(next);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}
