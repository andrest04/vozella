import fs from 'node:fs/promises';
import {
  applySettingsPatch,
  parseSettingsJson,
  readNextSessionDates,
  readSettings,
  serializeSettings,
  withNextSessionDate,
  LibraryFileCorruptError,
  type AppSettings,
  type Logger,
  type NextSessionDateStore,
  type RawSettings,
  type SettingsStore,
} from '@vozella/core';
import { writeFileAtomic } from '../fs/atomic-write';
import { fileLocks, lockKeyFor, type KeyedMutex } from '../fs/keyed-mutex';
import { errorCode, exists } from './library-layout';

export interface JsonSettingsStoreOptions {
  readonly settingsFilePath: string;
  /** Called before every write (spec 3.17: Save runs EnsureDirectoriesExist first). */
  readonly ensureDirectories?: () => Promise<void>;
  readonly logger?: Logger;
  readonly locks?: KeyedMutex;
  /** Called when a damaged file was set aside, so the user can be told (B5). */
  readonly onDamaged?: (info: { readonly keptAs: string; readonly message: string }) => void;
}

/**
 * `settings.json` in the app data root. Reads never throw on a damaged file: the app starts
 * with defaults, and the damaged file is moved aside (not overwritten) on the next write.
 * `update` is read-modify-write under one lock and changes only the fields in the patch, so two
 * callers cannot overwrite each other's fields (B17), and keys it does not know are kept.
 */
export class JsonSettingsStore implements SettingsStore, NextSessionDateStore {
  private readonly locks: KeyedMutex;

  constructor(private readonly options: JsonSettingsStoreOptions) {
    this.locks = options.locks ?? fileLocks;
  }

  async load(): Promise<AppSettings> {
    return readSettings(await this.locked(() => this.readRaw()));
  }

  update(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.locked(async () => {
      await this.options.ensureDirectories?.();
      const raw = await this.readRaw();
      const next = applySettingsPatch(raw, patch);
      await writeFileAtomic(this.options.settingsFilePath, serializeSettings(next));
      return readSettings(next);
    });
  }

  /** The remembered next-session date for a title key (`nextSessionDates` in the file). */
  async loadNextSessionDate(titleKey: string): Promise<string | null> {
    const dates = readNextSessionDates(await this.locked(() => this.readRaw()));
    return Object.hasOwn(dates, titleKey) ? (dates[titleKey] ?? null) : null;
  }

  /** Read-modify-write under the same lock as `update`, so neither loses the other's change. */
  rememberNextSessionDate(titleKey: string, date: string): Promise<void> {
    return this.locked(async () => {
      await this.options.ensureDirectories?.();
      const next = withNextSessionDate(await this.readRaw(), titleKey, date);
      await writeFileAtomic(this.options.settingsFilePath, serializeSettings(next));
    });
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return this.locks.run(lockKeyFor(this.options.settingsFilePath), work);
  }

  private async readRaw(): Promise<RawSettings> {
    let text: string;
    try {
      text = await fs.readFile(this.options.settingsFilePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {};
      throw error;
    }
    try {
      return parseSettingsJson(text).raw;
    } catch (error) {
      if (!(error instanceof LibraryFileCorruptError)) throw error;
      const aside = await this.moveAside();
      this.options.logger?.warn('settings.json is damaged; using defaults', {
        error: error.message,
        keptAs: aside,
      });
      this.options.onDamaged?.({ keptAs: aside, message: error.message });
      return {};
    }
  }

  /** `settings.json.corrupt`, then `.corrupt.1`, ... Never overwrites an earlier copy. */
  private async moveAside(): Promise<string> {
    const base = `${this.options.settingsFilePath}.corrupt`;
    let target = base;
    for (let n = 1; await exists(target); n += 1) target = `${base}.${n}`;
    await fs.rename(this.options.settingsFilePath, target);
    return target;
  }
}
