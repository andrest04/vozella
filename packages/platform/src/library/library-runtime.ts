import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
  LibraryService,
  ProjectService,
  createAppPaths,
  createStorageLayout,
  type AppPaths,
  type AppSettings,
  type ChatThreadRepository,
  type Clock,
  type Logger,
  type MeetingBusyProbe,
  type ProjectContextSource,
  type ProjectFileStore,
  type ProjectRepository,
  type StorageState,
} from '@vozella/core';
import type { DocumentExtractor } from '../chat/document-extraction';
import { createChatThreadStore } from '../chat/chat-thread-store';
import { writeFileAtomic } from '../fs/atomic-write';
import {
  ForbiddenDataRootError,
  assertNotProtectedRoot,
  type DataRoots,
  type RunMode,
} from '../data-root/resolve-data-root';
import { ensureDirectoriesExist } from './ensure-directories';
import { JsonSettingsStore } from './json-settings-store';
import { errorCode } from './library-layout';
import { MarkdownMeetingRepository } from './markdown-meeting-repository';
import { createProjectContextSource } from '../projects/project-context-source';
import { createProjectFileStore } from '../projects/project-file-store';
import { createProjectRepository } from '../projects/project-repository';
import {
  createMigrationNoticeStore,
  migrateStorage,
  type StorageMigration,
} from '../projects/storage-migrator';
import { StorageStateHolder } from '../projects/storage-state';

export type LocationSource = DataRoots['source'] | 'chosen';
export type LibraryChangeReason = 'meeting' | 'project' | 'location';

export interface LibraryLocation {
  readonly libraryRoot: string;
  readonly appDataRoot: string;
  readonly source: LocationSource;
  readonly version: string;
  /** Why the library storage could not be prepared, if it could not. */
  readonly startupError: string | null;
}

export type SetLocationResult =
  | { readonly status: 'changed'; readonly location: LibraryLocation }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'refused';
      readonly reason: 'not-absolute' | 'forbidden' | 'unusable';
      readonly message: string;
    };

export interface OpenFolderResult {
  readonly opened: boolean;
  readonly error: string | null;
}

export interface LibraryRuntimeDeps {
  readonly mode: RunMode;
  /** From `resolveDataRoots`: the default Library root is `roots.meetings`. */
  readonly roots: DataRoots;
  readonly guard: {
    readonly localAppData: string;
    readonly documents: string;
    readonly tempDir: string;
    readonly realpath?: (path: string) => string;
  };
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly busy: MeetingBusyProbe;
  /** Electron's `shell.openPath`: resolves to '' on success, otherwise an error message. */
  readonly openPath: (path: string) => Promise<string>;
  /** Electron's `shell.trashItem`. Without it a deleted meeting's files are unlinked. */
  readonly discard?: (path: string) => Promise<void>;
  /** Extracts the text of a context file (PDF, Word and PowerPoint run in a worker thread). */
  readonly extractor: DocumentExtractor;
  /** Shows a folder picker. Null when the user cancels. */
  readonly pickFolder: (defaultPath: string) => Promise<string | null>;
  readonly version: string;
  /** The storage migrations to run. Defaults to the registry; tests inject their own. */
  readonly migrations?: readonly StorageMigration[];
  readonly onChanged?: (reason: LibraryChangeReason) => void;
  /** A damaged settings.json was set aside; the Settings page tells the user. */
  readonly onSettingsDamaged?: (info: {
    readonly keptAs: string;
    readonly message: string;
  }) => void;
}

const LOCATION_FILE = 'library-location.json';

/** The methods of a service that return an async iterable, which a gated call must not wrap in a promise. */
const ITERABLE_METHODS: ReadonlySet<string | symbol> = new Set(['bodies']);

/**
 * Owns where the library lives and the services built on that place. The app data root is fixed
 * for the process; the Library root can be changed in Settings.
 *
 * Ordering (design 4.4): `build()` constructs the services into locals, runs `migrateStorage` to
 * completion and only then publishes them. Every service getter returns a stable gate: a call made
 * before the first build published waits for it, so no handle works before the manifest exists and
 * no meeting save runs before the migration settled. Once published, a call goes straight to the
 * current services. A location change builds and migrates the new root while the old services keep
 * serving, then swaps. A failing build still publishes its services, in the `error` or `newer`
 * state, where project writes are refused and meetings stay where they are.
 *
 * Folder choice rules (data safety): the environment override and the dev and test modes refuse
 * the real data folders. Only a production build with no override lets the user pick any folder.
 */
export class LibraryRuntime {
  private services: Services | undefined;
  /** The first build, started by `start()`. Gated calls wait for it. */
  private starting: Promise<void> | undefined;
  /** Builds run one at a time, in the order they were asked for. */
  private queue: Promise<unknown> = Promise.resolve();
  private chosen: string | null = null;
  private startupError: string | null = null;
  private readonly gates = new Map<string, object>();
  readonly settings: JsonSettingsStore;
  private readonly appPaths: () => AppPaths;

  constructor(private readonly deps: LibraryRuntimeDeps) {
    this.appPaths = () =>
      createAppPaths({ appData: deps.roots.appData, library: this.libraryRoot }, nodePath);
    this.settings = new JsonSettingsStore({
      settingsFilePath: nodePath.join(deps.roots.appData, 'settings.json'),
      ensureDirectories: () => ensureDirectoriesExist(this.appPaths()),
      logger: deps.logger,
      ...(deps.onSettingsDamaged ? { onDamaged: deps.onSettingsDamaged } : {}),
    });
  }

  // -------------------------------------------------------------- lifecycle

  /** Reads the saved choice, builds the services, ensures directories and runs the migrations. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      this.chosen = await this.readChoice();
      await this.build();
    })();
    return this.starting;
  }

  get service(): LibraryService {
    return this.gate('service', (s) => s.service);
  }

  get meetings(): MarkdownMeetingRepository {
    return this.gate('meetings', (s) => s.meetings);
  }

  get projects(): ProjectRepository {
    return this.gate('projects', (s) => s.projects);
  }

  get projectService(): ProjectService {
    return this.gate('projectService', (s) => s.projectService);
  }

  get projectFiles(): ProjectFileStore {
    return this.gate('projectFiles', (s) => s.projectFiles);
  }

  get chatThreads(): ChatThreadRepository {
    return this.gate('chatThreads', (s) => s.chatThreads);
  }

  get projectContext(): ProjectContextSource {
    return this.gate('projectContext', (s) => s.projectContext);
  }

  /** The state of the current library storage; `migrating` until the first build published. */
  get storageState(): StorageState {
    return this.services?.state.current() ?? { status: 'migrating' };
  }

  get paths(): AppPaths {
    return this.appPaths();
  }

  get libraryRoot(): string {
    return this.chosen ?? this.deps.roots.meetings;
  }

  location(): LibraryLocation {
    return {
      libraryRoot: this.libraryRoot,
      appDataRoot: this.deps.roots.appData,
      source: this.chosen === null ? this.deps.roots.source : 'chosen',
      version: this.deps.version,
      startupError: this.startupError,
    };
  }

  // ------------------------------------------------------------- location UI

  /** `null` goes back to the default folder. */
  async setLocation(path: string | null): Promise<SetLocationResult> {
    if (path === null) {
      await fs.rm(this.choiceFile(), { force: true });
      this.chosen = null;
      await this.build();
      this.deps.onChanged?.('location');
      return { status: 'changed', location: this.location() };
    }
    const refusal = await this.validateChoice(path);
    if (refusal) return refusal;

    const resolved = nodePath.resolve(path);
    await writeFileAtomic(this.choiceFile(), JSON.stringify({ libraryRoot: resolved }, null, 2));
    this.chosen = resolved;
    await this.build();
    this.deps.onChanged?.('location');
    return { status: 'changed', location: this.location() };
  }

  async chooseLocation(): Promise<SetLocationResult> {
    const picked = await this.deps.pickFolder(this.libraryRoot);
    return picked === null ? { status: 'cancelled' } : this.setLocation(picked);
  }

  /** Ensures the directories exist, then opens the Library root in the file manager. */
  async openFolder(): Promise<OpenFolderResult> {
    try {
      await ensureDirectoriesExist(this.paths);
      const error = await this.deps.openPath(this.libraryRoot);
      return error === '' ? { opened: true, error: null } : { opened: false, error };
    } catch (error) {
      return { opened: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async loadSettings(): Promise<AppSettings> {
    return this.settings.load();
  }

  // ---------------------------------------------------------------- internals

  /**
   * A stable stand-in for one service. Before the first build published, a call waits for it;
   * afterwards a call goes to whatever services are current, so a location change swaps them under
   * every holder. Only methods can be called before publishing.
   */
  private gate<T extends object>(key: string, pick: (services: Services) => T): T {
    const known = this.gates.get(key);
    if (known) return known as T;
    const gate = new Proxy({} as T, {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        const services = this.services;
        if (services) {
          const target = pick(services);
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        }
        const starting = this.starting;
        if (starting === undefined) throw new Error('The library runtime has not been started.');
        const published = async (): Promise<T> => {
          await starting;
          const ready = this.services;
          if (ready === undefined) throw new Error('The library runtime has not been started.');
          return pick(ready);
        };
        const callOn = (target: T, args: unknown[]): unknown =>
          (Reflect.get(target, property, target) as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
        if (ITERABLE_METHODS.has(property)) {
          return async function* (...args: unknown[]) {
            yield* callOn(await published(), args) as AsyncIterable<unknown>;
          };
        }
        return async (...args: unknown[]) => callOn(await published(), args);
      },
    });
    this.gates.set(key, gate);
    return gate;
  }

  private choiceFile(): string {
    return nodePath.join(this.deps.roots.appData, LOCATION_FILE);
  }

  /** Where the guard is lifted: a production build that was not given an override. */
  private get permissive(): boolean {
    return this.deps.mode === 'production' && this.deps.roots.source === 'default';
  }

  private guardInput() {
    return {
      env: {},
      mode: this.deps.mode,
      localAppData: this.deps.guard.localAppData,
      documents: this.deps.guard.documents,
      tempDir: this.deps.guard.tempDir,
      realpath: this.deps.guard.realpath,
    };
  }

  private async validateChoice(path: string): Promise<SetLocationResult | undefined> {
    if (!nodePath.isAbsolute(path)) {
      return {
        status: 'refused',
        reason: 'not-absolute',
        message: 'The folder must be an absolute path.',
      };
    }
    if (!this.permissive) {
      try {
        assertNotProtectedRoot(nodePath.resolve(path), this.guardInput());
      } catch (error) {
        if (error instanceof ForbiddenDataRootError) {
          return { status: 'refused', reason: 'forbidden', message: error.message };
        }
        throw error;
      }
    }
    try {
      await fs.mkdir(path, { recursive: true });
      const stat = await fs.stat(path);
      if (!stat.isDirectory()) throw new Error('not a directory');
      await fs.access(path, fs.constants.W_OK);
    } catch (error) {
      return {
        status: 'refused',
        reason: 'unusable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return undefined;
  }

  /** The saved choice, if it is still allowed. A refused or unreadable choice falls back quietly. */
  private async readChoice(): Promise<string | null> {
    let text: string;
    try {
      text = await fs.readFile(this.choiceFile(), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const value = (JSON.parse(text) as { libraryRoot?: unknown }).libraryRoot;
      if (typeof value !== 'string' || !nodePath.isAbsolute(value)) return null;
      if (!this.permissive) assertNotProtectedRoot(nodePath.resolve(value), this.guardInput());
      return nodePath.resolve(value);
    } catch (error) {
      this.deps.logger.warn('ignoring the saved library folder', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Builds one after another, so two location changes in a row cannot interleave. */
  private build(): Promise<void> {
    const run = this.queue.then(
      () => this.buildNow(),
      () => this.buildNow(),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async buildNow(): Promise<void> {
    const libraryRoot = this.libraryRoot;
    const paths = createAppPaths(
      { appData: this.deps.roots.appData, library: libraryRoot },
      nodePath,
    );
    await fs.mkdir(paths.rootDirectory, { recursive: true });
    await fs.mkdir(paths.userDataDirectory, { recursive: true });

    // Everything is built into locals first; nothing is published before the migration settled.
    const layout = createStorageLayout(libraryRoot, nodePath);
    const state = new StorageStateHolder({ status: 'migrating' });
    const projects = createProjectRepository({
      libraryRoot,
      logger: this.deps.logger,
      clock: this.deps.clock,
      newId: this.deps.newId,
      state,
      ...(this.deps.discard ? { discard: this.deps.discard } : {}),
    });
    const meetings = new MarkdownMeetingRepository({
      root: paths.userDataDirectory,
      placement: projects,
      logger: this.deps.logger,
      ...(this.deps.discard ? { discard: this.deps.discard } : {}),
    });
    const service = new LibraryService({ meetings, projects, busy: this.deps.busy });
    const projectFiles = createProjectFileStore({
      layout,
      extractor: this.deps.extractor,
      state,
      logger: this.deps.logger,
      clock: this.deps.clock,
      newId: this.deps.newId,
      ...(this.deps.discard ? { discard: this.deps.discard } : {}),
    });
    const chatThreads = createChatThreadStore({
      layout,
      state,
      logger: this.deps.logger,
      clock: this.deps.clock,
      ...(this.deps.discard ? { discard: this.deps.discard } : {}),
    });
    const projectContext = createProjectContextSource({ projects, files: projectFiles });
    const projectService = new ProjectService({
      projects,
      meetings,
      files: projectFiles,
      threads: chatThreads,
      busy: this.deps.busy,
      notice: createMigrationNoticeStore({ layout, state }),
    });

    await ensureDirectoriesExist(paths);
    let settled: StorageState;
    try {
      settled = await migrateStorage(
        {
          libraryRoot,
          appDataRoot: this.deps.roots.appData,
          layout,
          logger: this.deps.logger,
          clock: this.deps.clock,
        },
        this.deps.migrations,
      );
    } catch (error) {
      settled = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    state.set(settled);
    this.startupError = settled.status === 'error' ? settled.message : null;
    this.services = {
      state,
      meetings,
      service,
      projects,
      projectService,
      projectFiles,
      chatThreads,
      projectContext,
    };
  }
}

interface Services {
  readonly state: StorageStateHolder;
  readonly meetings: MarkdownMeetingRepository;
  readonly service: LibraryService;
  readonly projects: ProjectRepository;
  readonly projectService: ProjectService;
  readonly projectFiles: ProjectFileStore;
  readonly chatThreads: ChatThreadRepository;
  readonly projectContext: ProjectContextSource;
}
