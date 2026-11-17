import type { Clock, Logger, StorageLayout, StorageState } from '@vozella/core';

/** What a migration step needs: where the library is and how to write and log. */
export interface MigrationContext {
  readonly libraryRoot: string;
  /** The app data root; the old folder list may still sit there. */
  readonly appDataRoot: string;
  readonly layout: StorageLayout;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** One forward step of the library storage. Steps run in order, each at most once per library. */
export interface StorageMigration {
  /** The `STORAGE_SCHEMA_VERSION` the library has after this step. */
  readonly toVersion: number;
  /** Stable id, recorded in the manifest log (for example `001-folders-to-projects`). */
  readonly id: string;
  run(context: MigrationContext): Promise<void>;
}

/**
 * The ordered registry. Contracts phase: empty; the storage lane adds
 * `001-folders-to-projects`. A bump of `STORAGE_SCHEMA_VERSION` needs one entry here.
 */
export const MIGRATIONS: readonly StorageMigration[] = [];

/**
 * Reads the manifest, refuses a newer one, applies every migration above the current version and
 * answers the resulting state. Never throws: a failing step answers `error`.
 *
 * Contracts phase stub: answers `ready` and touches nothing. The storage lane replaces the body.
 */
export function migrateStorage(_context: MigrationContext): Promise<StorageState> {
  return Promise.resolve({ status: 'ready' });
}
