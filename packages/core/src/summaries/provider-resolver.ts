import type { ApiKeyStore } from '../api-keys/api-key-store';
import type { SettingsStore } from '../library/ports';
import {
  isApiProvider,
  isProviderAvailable,
  resolveSummaryProviderKind,
  type ApiProviderKind,
  type SummaryProviderKind,
} from '../library/settings';
import type { CliProviderKind } from '../library/settings';
import { API_ENGINES, apiSetupGap } from '../settings/api-providers';
import { cliExecutableName } from '../settings/cli-providers';
import type { CliPathProbe, LocalModelStore } from '../settings/ports';
import { findSummaryModel } from '../settings/summary-models';
import type { SummaryProvider } from './provider';
import type { SummaryProviderFactory } from './provider-factory';

export type SetupKind = 'Local' | CliProviderKind | ApiProviderKind;

/** Why an engine is not ready. `key-missing` and `base-url-missing` are for API key engines. */
export type SetupReason = 'model-missing' | 'cli-missing' | 'key-missing' | 'base-url-missing';

/**
 * The answer of the readiness gate (spec 2.7). It is a value, never a dialog: the caller decides
 * whether to open the wizard or the CLI setup dialog for a `needs-setup`.
 */
export type ProviderResolution =
  | {
      readonly status: 'ready';
      readonly kind: SetupKind;
      readonly provider: SummaryProvider;
      /** Set for Local only. */
      readonly modelPath?: string;
    }
  | {
      readonly status: 'needs-setup';
      readonly kind: SetupKind;
      readonly reason: SetupReason;
    }
  | { readonly status: 'unavailable'; readonly kind: 'Xai'; readonly reason: 'xai-removed' };

export interface ResolveRequest {
  /** Defaults to the provider the settings select (unknown names are Local, B35). */
  readonly kind?: SummaryProviderKind;
  /** The live-answer path only (item 143). */
  readonly webSearch?: boolean;
}

export interface SummaryProviderResolverDeps {
  readonly settings: SettingsStore;
  readonly cli: CliPathProbe;
  /** The model folder: a catalog entry counts only when its file is complete. */
  readonly models: Pick<LocalModelStore, 'isDownloaded'> & {
    pathFor(fileName: string): string;
  };
  readonly factory: SummaryProviderFactory;
  /** Whether a key is saved for an API engine. Never asked for the key itself. */
  readonly apiKeys: Pick<ApiKeyStore, 'has'>;
}

export class SummaryProviderResolver {
  constructor(private readonly deps: SummaryProviderResolverDeps) {}

  async resolveSummaryProvider(request: ResolveRequest = {}): Promise<ProviderResolution> {
    const settings = await this.deps.settings.load();
    const kind = request.kind ?? resolveSummaryProviderKind(settings);
    if (!isProviderAvailable(kind)) {
      return { status: 'unavailable', kind, reason: 'xai-removed' };
    }
    if (kind === 'Local') {
      const model = findSummaryModel(settings.selectedSummaryModelId);
      if (model === null || !(await this.deps.models.isDownloaded(model))) {
        return { status: 'needs-setup', kind, reason: 'model-missing' };
      }
      const modelPath = this.deps.models.pathFor(model.fileName);
      const provider = await this.deps.factory.create(kind, { modelPath });
      return { status: 'ready', kind, provider, modelPath };
    }
    if (isApiProvider(kind)) {
      const engine = API_ENGINES[kind];
      const hasKey = engine.requiresKey ? await this.deps.apiKeys.has(kind) : false;
      const gap = apiSetupGap(engine, settings, hasKey);
      if (gap !== null) return { status: 'needs-setup', kind, reason: gap };
      const provider = await this.deps.factory.create(kind);
      return { status: 'ready', kind, provider };
    }
    if (!(await this.deps.cli.isOnPath(cliExecutableName(kind)))) {
      return { status: 'needs-setup', kind, reason: 'cli-missing' };
    }
    const provider = await this.deps.factory.create(kind, {
      webSearch: request.webSearch === true,
    });
    return { status: 'ready', kind, provider };
  }
}

/** `CliProviderResolver.EnsureAvailableAsync` without the dialog: is the executable on PATH. */
export function isCliAvailable(cli: CliPathProbe, kind: SummaryProviderKind): Promise<boolean> {
  return cli.isOnPath(cliExecutableName(kind));
}
