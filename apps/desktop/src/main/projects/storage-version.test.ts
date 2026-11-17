import {
  STORAGE_KIND_VERSIONS,
  chatThreadFileSchema,
  extractedTextSchema,
  libraryManifestSchema,
  projectFileMetaSchema,
  projectRecordSchema,
} from '@vozella/contracts';
import { STORAGE_SCHEMA_VERSION } from '@vozella/core';
import { MIGRATIONS } from '@vozella/platform';
import { describe, expect, it } from 'vitest';

/**
 * The version rule of the library storage: the manifest version is the only one that gates
 * opening a library, and a per-kind version may never run ahead of it. The three packages each
 * hold a number; this is the one place that sees them all.
 */
describe('storage version rule', () => {
  it('no persisted kind is newer than the storage schema version', () => {
    expect(Math.max(...Object.values(STORAGE_KIND_VERSIONS))).toBeLessThanOrEqual(
      STORAGE_SCHEMA_VERSION,
    );
  });

  it('the manifest kind is at exactly the storage schema version', () => {
    expect(STORAGE_KIND_VERSIONS.manifest).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('every kind schema accepts the version it declares and refuses the next one', () => {
    const next = STORAGE_SCHEMA_VERSION + 1;
    const schemas = {
      manifest: libraryManifestSchema,
      project: projectRecordSchema,
      fileMeta: projectFileMetaSchema,
      extractedText: extractedTextSchema,
      thread: chatThreadFileSchema,
    };
    for (const [kind, schema] of Object.entries(schemas)) {
      const declared = STORAGE_KIND_VERSIONS[kind as keyof typeof STORAGE_KIND_VERSIONS];
      const shape = (
        schema as unknown as {
          shape: { schemaVersion: { safeParse(v: unknown): { success: boolean } } };
        }
      ).shape;
      expect(shape.schemaVersion.safeParse(declared).success, kind).toBe(true);
      expect(shape.schemaVersion.safeParse(next).success, kind).toBe(false);
    }
  });

  it('no migration targets a version the app does not support, and the registry is in order', () => {
    const versions = MIGRATIONS.map((migration) => migration.toVersion);
    expect(Math.max(0, ...versions)).toBeLessThanOrEqual(STORAGE_SCHEMA_VERSION);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});
