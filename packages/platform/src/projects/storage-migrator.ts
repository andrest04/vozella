import {
  STORAGE_SCHEMA_VERSION,
  StorageTooNewError,
  type Clock,
  type Logger,
  type StorageLayout,
  type StorageState,
} from '@vozella/core';
import type { LibraryManifestRecord } from '@vozella/contracts';
import { foldersToProjects } from './migrations/001-folders-to-projects';
import { ManifestCorruptError, readManifest, writeManifest } from './storage-migrator-manifest';

export { createMigrationNoticeStore } from './storage-migrator-notice';

/** What a migration step needs: where the library is and how to write and log. */
export interface MigrationContext {
  readonly libraryRoot: string;
  /** The app data root; the old folder list may still sit there. */
  readonly appDataRoot: string;
  readonly layout: StorageLayout;
  readonly logger: Logger;
  readonly clock: Clock;
}

type ManifestEntry = LibraryManifestRecord['migrations'][number];

/** What a step hands back so the migrator can record it. */
export interface MigrationOutcome {
  /** Stored in the manifest's migration log. */
  readonly report?: NonNullable<ManifestEntry['report']>;
  /** The one-time notice the page shows. */
  readonly pendingNotice?: NonNullable<LibraryManifestRecord['pendingNotice']>;
  /** Runs after the manifest was written. Best effort: a failure is logged, never fatal. */
  readonly afterCommit?: () => Promise<void>;
}

/** One forward step of the library storage. Steps run in order, each at most once per library. */
export interface StorageMigration {
  /** The `STORAGE_SCHEMA_VERSION` the library has after this step. */
  readonly toVersion: number;
  /** Stable id, recorded in the manifest log (for example `001-folders-to-projects`). */
  readonly id: string;
  run(context: MigrationContext): Promise<MigrationOutcome>;
  /**
   * Best-effort follow-up for a step that already ran, tried again on every launch (for example
   * a leftover file the step could not delete). Never rewrites the manifest.
   */
  settle?(context: MigrationContext, entry: ManifestEntry): Promise<void>;
}

/**
 * The ordered registry. A bump of `STORAGE_SCHEMA_VERSION` needs exactly one entry here, in the
 * same commit, and a per-kind `schemaVersion` may never exceed it.
 */
export const MIGRATIONS: readonly StorageMigration[] = [foldersToProjects];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reads the manifest, refuses a newer one, applies every migration above the current version in
 * order and answers the resulting state. After each step the manifest is written atomically with
 * the new version and a log entry, so a crash between two steps resumes at the next one. Never
 * throws: a failing step stops the run, leaves the manifest as it was (the next launch retries)
 * and answers `error`. A newer manifest answers `newer` and nothing is written under `.vozella`.
 */
export async function migrateStorage(
  context: MigrationContext,
  migrations: readonly StorageMigration[] = MIGRATIONS,
): Promise<StorageState> {
  const { layout, logger, clock } = context;
  try {
    let manifest = await readManifest(layout);
    const start = manifest?.schemaVersion ?? 0;
    for (const step of migrations.filter((m) => m.toVersion > start)) {
      logger.info('running a storage migration', { id: step.id, toVersion: step.toVersion });
      const outcome = await step.run(context);
      const appliedAt = clock.now().toISOString();
      const entry: ManifestEntry = {
        id: step.id,
        appliedAt,
        ...(outcome.report ? { report: outcome.report } : {}),
      };
      const next = {
        ...(manifest ?? { createdAt: appliedAt }),
        schemaVersion: step.toVersion,
        migrations: [...(manifest?.migrations ?? []), entry],
        ...(outcome.pendingNotice
          ? { pendingNotice: outcome.pendingNotice }
          : manifest?.pendingNotice === undefined
            ? {}
            : { pendingNotice: manifest.pendingNotice }),
      } as LibraryManifestRecord;
      await writeManifest(layout, next);
      manifest = next;
      if (outcome.afterCommit) {
        await outcome.afterCommit().catch((error: unknown) => {
          logger.warn('a storage migration could not finish its cleanup', {
            id: step.id,
            error: messageOf(error),
          });
        });
      }
    }
    if (manifest !== null) {
      for (const entry of manifest.migrations) {
        const step = migrations.find((m) => m.id === entry.id);
        if (start > 0 && step?.settle) {
          await step.settle(context, entry).catch((error: unknown) => {
            logger.warn('a storage migration could not settle', {
              id: entry.id,
              error: messageOf(error),
            });
          });
        }
      }
    }
    return { status: 'ready' };
  } catch (error) {
    if (error instanceof StorageTooNewError) {
      logger.warn('the library was written by a newer version', {
        found: error.found,
        supported: error.supported,
      });
      return { status: 'newer', found: error.found, supported: STORAGE_SCHEMA_VERSION };
    }
    logger.error('the library storage could not be prepared', {
      error: error instanceof ManifestCorruptError ? error.message : messageOf(error),
    });
    return { status: 'error', message: messageOf(error) };
  }
}
