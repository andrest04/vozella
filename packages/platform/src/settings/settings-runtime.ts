import nodePath from 'node:path';
import {
  API_ENGINES,
  API_FAILURE_UI_KEYS,
  API_KEY_SETTINGS_UI_KEYS,
  ExitGateRegistry,
  LocalModelsService,
  RestartService,
  SettingsCommands,
  SettingsNotices,
  SettingsPageService,
  isApiProviderError,
  type ApiKeyStore,
  type ApiProviderKind,
  type CliPathProbe,
  type HardwareProbe,
  type LocalModelStore,
  type ModelEvent,
  type SettingsCapabilities,
  type SettingsStore,
} from '@vozella/core';
import { globalFetch } from '../api-providers/api-http';
import { listApiModels } from '../api-providers/list-models';
import { FileLocalModelStore } from './file-local-model-store';
import { PathCliProbe } from './path-cli-probe';
import { SystemHardwareProbe } from './system-hardware-probe';

/** How long Verify waits for the model list before it says the engine took too long. */
export const API_VERIFY_TIMEOUT_MS = 20_000;

export interface SettingsRuntimeDeps {
  readonly store: SettingsStore;
  /** `<app data>\SummaryModels`. */
  readonly appDataDirectory: string;
  /** Electron: `app.getPreferredSystemLanguages()`. */
  readonly osLanguages: () => readonly string[];
  /** Electron: `app.relaunch()` then `app.exit(0)`. */
  readonly relaunch: () => void | Promise<void>;
  readonly notifyModel: (event: ModelEvent) => void;
  /** Replacements for tests and for the fake native build. */
  readonly hardware?: HardwareProbe;
  readonly modelStore?: LocalModelStore;
  readonly cli?: CliPathProbe;
  /** Whether the llama runtime in use offloads to the GPU; undefined until one is picked. */
  readonly activeGpuOffload?: () => boolean | undefined;
  /** The one API key store (BYOK) the summaries share. Without it no key can be saved. */
  readonly apiKeys?: ApiKeyStore;
  /** The HTTP client Verify uses. A fake in tests and in the fake native build. */
  readonly fetch?: typeof fetch;
  /** Defaults to `API_VERIFY_TIMEOUT_MS`. */
  readonly verifyTimeoutMs?: number;
}

/** What a key change did. The key itself is never part of an answer. */
export type ApiKeyOutcome =
  | { readonly status: 'saved'; readonly keySet: boolean }
  | { readonly status: 'failed'; readonly errorKey: string };

export type ApiVerifyOutcome =
  | { readonly status: 'verified'; readonly models: readonly string[] }
  | { readonly status: 'failed'; readonly errorKey: string };

const API_KEY_STORE_UNAVAILABLE_KEY = API_KEY_SETTINGS_UI_KEYS.storeUnavailable;
const API_BASE_URL_MISSING_KEY = API_KEY_SETTINGS_UI_KEYS.baseUrlMissing;

/**
 * The Settings side of the API key engines: save or remove a key, and Verify it by listing the
 * models it can use. Keys go into the store and never come back out of this class; answers carry
 * a flag, a model list, or the catalog key of the reason.
 */
export class ApiKeySettings {
  constructor(
    private readonly deps: {
      readonly store: SettingsStore;
      readonly apiKeys: ApiKeyStore | undefined;
      readonly fetch: typeof fetch;
      readonly timeoutMs: number;
    },
  ) {}

  async set(kind: ApiProviderKind, key: string): Promise<ApiKeyOutcome> {
    const keys = this.deps.apiKeys;
    if (!keys) return { status: 'failed', errorKey: API_KEY_STORE_UNAVAILABLE_KEY };
    try {
      await keys.set(kind, key);
      return { status: 'saved', keySet: await keys.has(kind) };
    } catch {
      // The adapter's message is not shown; it may say why encryption failed, never the key.
      return { status: 'failed', errorKey: API_KEY_STORE_UNAVAILABLE_KEY };
    }
  }

  async clear(kind: ApiProviderKind): Promise<ApiKeyOutcome> {
    const keys = this.deps.apiKeys;
    if (!keys) return { status: 'saved', keySet: false };
    try {
      await keys.delete(kind);
      return { status: 'saved', keySet: await keys.has(kind) };
    } catch {
      return { status: 'failed', errorKey: API_KEY_STORE_UNAVAILABLE_KEY };
    }
  }

  async verify(kind: ApiProviderKind): Promise<ApiVerifyOutcome> {
    const engine = API_ENGINES[kind];
    const settings = await this.deps.store.load();
    if (engine.resolveBaseUrl(settings) === null) {
      return { status: 'failed', errorKey: API_BASE_URL_MISSING_KEY };
    }
    const key = (await this.deps.apiKeys?.get(kind)) ?? null;
    try {
      const models = await listApiModels(engine, settings, key, this.deps.fetch, {
        timeoutMs: this.deps.timeoutMs,
      });
      return { status: 'verified', models };
    } catch (error) {
      const failure = isApiProviderError(error) ? error.kind : 'Unknown';
      return { status: 'failed', errorKey: API_FAILURE_UI_KEYS[failure] };
    }
  }
}

/**
 * The Settings services wired to their adapters. The composition root creates one; the IPC
 * handlers call it. Other modules reach their own Settings sections through `exitGates`,
 * the `store` they already share, and the ports named in the spec.
 */
export class SettingsRuntime {
  readonly notices = new SettingsNotices();
  readonly exitGates = new ExitGateRegistry();
  readonly commands: SettingsCommands;
  readonly models: LocalModelsService;
  readonly page: SettingsPageService;
  readonly restart: RestartService;
  readonly capabilities: SettingsCapabilities;
  readonly apiKeys: ApiKeySettings;
  private readonly hardwareProbe: HardwareProbe;

  constructor(deps: SettingsRuntimeDeps) {
    this.capabilities = { localModels: true };
    this.commands = new SettingsCommands({ store: deps.store, osLanguages: deps.osLanguages });
    this.models = new LocalModelsService({
      store:
        deps.modelStore ??
        new FileLocalModelStore({
          directory: nodePath.join(deps.appDataDirectory, 'SummaryModels'),
        }),
      settings: deps.store,
      notify: deps.notifyModel,
    });
    this.hardwareProbe = deps.hardware ?? new SystemHardwareProbe();
    this.page = new SettingsPageService({
      store: deps.store,
      osLanguages: deps.osLanguages,
      hardware: this.hardwareProbe,
      models: this.models,
      cli: deps.cli ?? new PathCliProbe(),
      notices: this.notices,
      capabilities: this.capabilities,
      ...(deps.activeGpuOffload ? { activeGpuOffload: deps.activeGpuOffload } : {}),
      ...(deps.apiKeys ? { apiKeys: deps.apiKeys } : {}),
    });
    this.restart = new RestartService({ gates: this.exitGates, relaunch: deps.relaunch });
    this.apiKeys = new ApiKeySettings({
      store: deps.store,
      apiKeys: deps.apiKeys,
      fetch: deps.fetch ?? globalFetch,
      timeoutMs: deps.verifyTimeoutMs ?? API_VERIFY_TIMEOUT_MS,
    });
  }

  /**
   * Starts the hardware query now. It takes seconds on a real machine (a PowerShell GPU read) and
   * the Settings page needs it for the fit badges, so the app calls this once at startup and the
   * first visit finds the answer cached. A failed query only means no badges.
   */
  warmUp(): void {
    this.hardwareProbe.detect().catch(() => undefined);
  }
}
