import type {
  MigrationNotice,
  MigrationNoticeStore,
  StorageLayout,
  StorageStateSource,
} from '@vozella/core';
import { fileLocks, lockKeyFor } from '../fs/keyed-mutex';
import { readManifest, writeManifest } from './storage-migrator-manifest';

/** The pending notice with its details from the migration log, or null when there is none. */
export async function readMigrationNotice(layout: StorageLayout): Promise<MigrationNotice | null> {
  try {
    const manifest = await readManifest(layout);
    if (manifest?.pendingNotice == null) return null;
    const report = [...manifest.migrations]
      .reverse()
      .find((entry) => entry.report !== undefined)?.report;
    return {
      kind: 'folders-to-projects',
      projects: manifest.pendingNotice.projects,
      renamed: report?.renamed.map(({ id, from, to }) => ({ id, from, to })) ?? [],
      skipped: report?.skipped.map(({ index, reason }) => ({ index, reason })) ?? [],
      legacyLeftovers: report?.legacyLeftovers ?? [],
    };
  } catch {
    return null;
  }
}

/** Clears the pending notice. Everything else in the manifest stays as it was. */
export async function clearMigrationNotice(layout: StorageLayout): Promise<void> {
  const manifest = await readManifest(layout);
  if (manifest?.pendingNotice == null) return;
  await writeManifest(layout, { ...manifest, pendingNotice: null });
}

/** The notice as a port: readable always, dismissible only while the storage is ready. */
export function createMigrationNoticeStore(deps: {
  readonly layout: StorageLayout;
  readonly state: StorageStateSource;
}): MigrationNoticeStore {
  const { layout, state } = deps;
  return {
    read: () => readMigrationNotice(layout),
    async dismiss() {
      if (state.current().status !== 'ready') return;
      await fileLocks.run(`manifest:${lockKeyFor(layout.manifestFile)}`, () =>
        clearMigrationNotice(layout),
      );
    },
  };
}
