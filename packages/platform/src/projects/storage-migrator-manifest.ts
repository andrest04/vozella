import fs from 'node:fs/promises';
import {
  STORAGE_SCHEMA_VERSION,
  StorageTooNewError,
  stripBom,
  type StorageLayout,
} from '@vozella/core';
import { libraryManifestSchema, type LibraryManifestRecord } from '@vozella/contracts';
import { writeFileAtomic } from '../fs/atomic-write';
import { errorCode } from '../library/library-layout';

/** The manifest exists but cannot be understood. It is never overwritten. */
export class ManifestCorruptError extends Error {
  constructor(detail: string) {
    super(`The library manifest is damaged: ${detail}`);
    this.name = 'ManifestCorruptError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads `.vozella/library.json`. Null means there is none (version 0). A manifest newer than
 * this app throws `StorageTooNewError`; one that cannot be read throws `ManifestCorruptError`.
 */
export async function readManifest(layout: StorageLayout): Promise<LibraryManifestRecord | null> {
  let content: string;
  try {
    content = await fs.readFile(layout.manifestFile, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new ManifestCorruptError(`unreadable (${String(errorCode(error))})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(content));
  } catch {
    throw new ManifestCorruptError('invalid JSON');
  }
  if (!isObject(raw)) throw new ManifestCorruptError('not an object');
  const version = raw.schemaVersion;
  if (typeof version === 'number' && version > STORAGE_SCHEMA_VERSION) {
    throw new StorageTooNewError(version, STORAGE_SCHEMA_VERSION);
  }
  const parsed = libraryManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestCorruptError(parsed.error.issues[0]?.message ?? 'invalid');
  }
  return parsed.data;
}

/** Atomically writes the manifest: plain UTF-8 JSON, LF, two-space indent. */
export async function writeManifest(
  layout: StorageLayout,
  manifest: LibraryManifestRecord,
): Promise<void> {
  await writeFileAtomic(layout.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
