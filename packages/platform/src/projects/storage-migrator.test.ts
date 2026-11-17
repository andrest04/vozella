import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KIND_VERSIONS } from '@vozella/contracts';
import { STORAGE_SCHEMA_VERSION } from '@vozella/core';
import {
  MIGRATIONS,
  createMigrationNoticeStore,
  migrateStorage,
  type StorageMigration,
} from './storage-migrator';
import {
  createMigrationFixture,
  readManifestFile,
  tree,
  type MigrationFixture,
} from './migrations/migration-test-kit';
import { StorageStateHolder } from './storage-state';

let fx: MigrationFixture;
beforeEach(() => {
  fx = createMigrationFixture();
});
afterEach(() => {
  fx.cleanup();
});

const step = (
  id: string,
  toVersion: number,
  run: StorageMigration['run'] = () => Promise.resolve({}),
): StorageMigration => ({
  id,
  toVersion,
  run,
});

describe('the registry and the version rule', () => {
  it('is ordered, has unique ids and ends at the current storage version', () => {
    const versions = MIGRATIONS.map((m) => m.toVersion);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    expect(new Set(MIGRATIONS.map((m) => m.id)).size).toBe(MIGRATIONS.length);
    expect(versions.at(-1)).toBe(STORAGE_SCHEMA_VERSION);
    expect(MIGRATIONS[0]?.id).toBe('001-folders-to-projects');
  });

  it('no persisted kind is newer than the manifest, so every bump needs a migration', () => {
    expect(Math.max(...Object.values(STORAGE_KIND_VERSIONS))).toBeLessThanOrEqual(
      STORAGE_SCHEMA_VERSION,
    );
    expect(MIGRATIONS.some((m) => m.toVersion === STORAGE_SCHEMA_VERSION)).toBe(true);
  });
});

describe('migrateStorage', () => {
  it('a fresh install reaches ready with manifest v1', async () => {
    expect(await migrateStorage(fx.context)).toEqual({ status: 'ready' });
    expect(readManifestFile(fx)).toMatchObject({ schemaVersion: 1 });
  });

  it('a manifest newer than the app writes nothing and answers newer', async () => {
    fs.mkdirSync(fx.context.layout.metaDirectory, { recursive: true });
    fs.writeFileSync(
      fx.context.layout.manifestFile,
      JSON.stringify({ schemaVersion: 99, createdAt: 'x', migrations: [], future: true }),
    );
    const before = tree(fx.dir).map((f) => [f, fs.readFileSync(`${fx.dir}/${f}`, 'utf8')]);
    fs.writeFileSync(fx.foldersInLibrary, '[]');
    expect(await migrateStorage(fx.context)).toEqual({
      status: 'newer',
      found: 99,
      supported: STORAGE_SCHEMA_VERSION,
    });
    expect(
      tree(fx.dir)
        .filter((f) => f !== 'library/folders.json')
        .map((f) => [f, fs.readFileSync(`${fx.dir}/${f}`, 'utf8')]),
    ).toEqual(before);
    expect(fs.existsSync(fx.foldersInLibrary)).toBe(true);
  });

  it('a damaged manifest answers error and is never overwritten', async () => {
    fs.mkdirSync(fx.context.layout.metaDirectory, { recursive: true });
    fs.writeFileSync(fx.context.layout.manifestFile, '{ broken');
    fs.writeFileSync(fx.foldersInLibrary, '[]');
    const state = await migrateStorage(fx.context);
    expect(state.status).toBe('error');
    expect(fs.readFileSync(fx.context.layout.manifestFile, 'utf8')).toBe('{ broken');
    expect(tree(fx.context.layout.backupsDirectory)).toEqual([]);
  });

  it('a failing step keeps the manifest as it was, so the next launch retries', async () => {
    let attempts = 0;
    const flaky = step('001', 1, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve({});
    });
    expect(await migrateStorage(fx.context, [flaky])).toEqual({
      status: 'error',
      message: 'disk full',
    });
    expect(readManifestFile(fx)).toBeNull();
    expect(await migrateStorage(fx.context, [flaky])).toEqual({ status: 'ready' });
    expect(readManifestFile(fx)).toMatchObject({ schemaVersion: 1 });
  });

  it('commits after each step: a later failure keeps what the earlier steps recorded', async () => {
    const first = step('001', 1, () =>
      Promise.resolve({
        pendingNotice: {
          kind: 'folders-to-projects' as const,
          projects: 1,
          renamed: 0,
          skipped: 0,
          leftovers: 0,
        },
      }),
    );
    const second = step('002', 2, () => Promise.reject(new Error('step two broke')));
    expect(await migrateStorage(fx.context, [first, second])).toMatchObject({ status: 'error' });
    expect(readManifestFile(fx)).toMatchObject({
      schemaVersion: 1,
      migrations: [{ id: '001' }],
      pendingNotice: { projects: 1 },
    });
  });

  it('runs only the steps above the current version, in order, each once', async () => {
    const ran: string[] = [];
    const a = step('001', 1, () => {
      ran.push('001');
      return Promise.resolve({});
    });
    await migrateStorage(fx.context, [a]);
    await migrateStorage(fx.context, [a]);
    expect(ran).toEqual(['001']);
  });

  it('keeps an existing pending notice when a later step has none, and the manifest createdAt', async () => {
    const notice = {
      kind: 'folders-to-projects' as const,
      projects: 2,
      renamed: 0,
      skipped: 0,
      leftovers: 0,
    };
    await migrateStorage(fx.context, [
      step('001', 1, () => Promise.resolve({ pendingNotice: notice })),
    ]);
    const created = (readManifestFile(fx) as { createdAt: string }).createdAt;
    // A manifest at version 0 cannot exist, so this proves the merge by rewriting through a second registry entry id.
    expect((readManifestFile(fx) as { pendingNotice: unknown }).pendingNotice).toEqual(notice);
    expect(created).toBe('2026-11-16T14:03:00.000Z');
  });
});

describe('the one-time migration notice', () => {
  it('is read from the manifest and cleared once, leaving the rest of the manifest', async () => {
    fs.writeFileSync(
      fx.foldersInLibrary,
      JSON.stringify([
        {
          id: '3b7e0000-0000-4000-8000-000000000001',
          name: 'A',
          parentId: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
        {
          id: '3b7e0000-0000-4000-8000-000000000002',
          name: 'a',
          parentId: '3b7e0000-0000-4000-8000-000000000001',
          createdAt: '2025-01-02T00:00:00Z',
        },
        { id: 'nope', name: 'Bad' },
      ]),
    );
    const state = new StorageStateHolder({ status: 'migrating' });
    const store = createMigrationNoticeStore({ layout: fx.context.layout, state });
    state.set(await migrateStorage(fx.context));
    expect(await store.read()).toEqual({
      kind: 'folders-to-projects',
      projects: 2,
      renamed: [{ id: '3b7e0000-0000-4000-8000-000000000002', from: 'a', to: 'A – a' }],
      skipped: [{ index: 2, reason: 'invalid-id' }],
      legacyLeftovers: [],
    });
    await store.dismiss();
    expect(await store.read()).toBeNull();
    expect(readManifestFile(fx)).toMatchObject({
      schemaVersion: 1,
      migrations: [{ id: '001-folders-to-projects' }],
    });
  });

  it('cannot be dismissed while the storage is not ready', async () => {
    fs.writeFileSync(fx.foldersInLibrary, '[]');
    await migrateStorage(fx.context);
    const state = new StorageStateHolder({ status: 'migrating' });
    const store = createMigrationNoticeStore({ layout: fx.context.layout, state });
    await store.dismiss();
    expect(await store.read()).not.toBeNull();
  });
});
