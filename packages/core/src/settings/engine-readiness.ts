import {
  API_PROVIDER_KINDS,
  CLI_PROVIDER_KINDS,
  type ApiProviderKind,
  type AppSettings,
  type CliProviderKind,
} from '../library/settings';
import type { ApiKeyStore } from '../api-keys/api-key-store';
import { API_ENGINES, apiSetupGap, type ApiSetupGap } from './api-providers';
import { cliExecutableName } from './cli-providers';
import type { ModelRows } from './local-models';
import type { CliPathProbe } from './ports';

/** Every engine the user can pick, in the order the page lists them. Xai is gone, so never here. */
export type SelectableEngineKind = 'Local' | CliProviderKind | ApiProviderKind;

export const SELECTABLE_ENGINE_KINDS = [
  'Local',
  ...CLI_PROVIDER_KINDS,
  ...API_PROVIDER_KINDS,
] as const satisfies readonly SelectableEngineKind[];

/**
 * Whether an engine can answer if it were picked now, else the first thing it still needs:
 * the CLI program, an API key, the compatible engine's server address, or a model (Local without
 * an active model on disk, or the compatible engine without a model id).
 */
export type SummaryEngineReadiness =
  'ready' | 'cli-missing' | 'needs-key' | 'needs-server' | 'needs-model';

export interface SummaryEngineStatus {
  readonly kind: SelectableEngineKind;
  readonly readiness: SummaryEngineReadiness;
  /** The model the engine would use, for display; null when there is none yet. */
  readonly model: string | null;
}

export interface SummaryEngineReadinessInput {
  readonly settings: AppSettings;
  /** Whether each CLI program is on the PATH. */
  readonly cliFound: Readonly<Record<CliProviderKind, boolean>>;
  /** The model each CLI engine resolves to. */
  readonly cliModel: Readonly<Record<CliProviderKind, string>>;
  /** Whether a key is saved per API engine. */
  readonly keySet: Readonly<Record<ApiProviderKind, boolean>>;
  readonly models: ModelRows;
}

const API_GAP_READINESS: Readonly<Record<ApiSetupGap, SummaryEngineReadiness>> = {
  'base-url-missing': 'needs-server',
  'key-missing': 'needs-key',
  'model-missing': 'needs-model',
};

/** One status per selectable engine, in display order. Pure: the caller gathers the facts. */
export function engineStatuses(input: SummaryEngineReadinessInput): readonly SummaryEngineStatus[] {
  const activeModel = input.models.rows.find((row) => row.active && row.downloaded);
  const local: SummaryEngineStatus = {
    kind: 'Local',
    readiness: activeModel ? 'ready' : 'needs-model',
    model: activeModel?.displayName ?? null,
  };
  const cli = CLI_PROVIDER_KINDS.map((kind): SummaryEngineStatus => ({
    kind,
    readiness: input.cliFound[kind] ? 'ready' : 'cli-missing',
    model: input.cliModel[kind],
  }));
  const api = API_PROVIDER_KINDS.map((kind): SummaryEngineStatus => {
    const engine = API_ENGINES[kind];
    const gap = apiSetupGap(engine, input.settings, input.keySet[kind]);
    const model = engine.resolveModel(input.settings);
    return {
      kind,
      readiness: gap === null ? 'ready' : API_GAP_READINESS[gap],
      model: model === '' ? null : model,
    };
  });
  return [local, ...cli, ...api];
}

/** What `engineStatuses` needs from outside the settings file: the PATH and the key store. */
export interface EngineAccess {
  readonly cliFound: Readonly<Record<CliProviderKind, boolean>>;
  readonly keySet: Readonly<Record<ApiProviderKind, boolean>>;
}

export interface EngineAccessDeps {
  readonly cli: CliPathProbe;
  /** Without it, no key reads as set. */
  readonly apiKeys?: Pick<ApiKeyStore, 'has'>;
}

/**
 * Probes both CLIs and asks the key store about every API engine, all at once. A probe that fails
 * reads as not found, so one broken check never keeps a page or a picker from loading.
 */
export async function readEngineAccess(deps: EngineAccessDeps): Promise<EngineAccess> {
  const found = (kind: CliProviderKind) =>
    deps.cli.isOnPath(cliExecutableName(kind)).catch(() => false);
  const hasKey = async (kind: ApiProviderKind) => (await deps.apiKeys?.has(kind)) ?? false;
  const [cli, keys] = await Promise.all([
    Promise.all(CLI_PROVIDER_KINDS.map(async (kind) => [kind, await found(kind)] as const)),
    Promise.all(API_PROVIDER_KINDS.map(async (kind) => [kind, await hasKey(kind)] as const)),
  ]);
  return {
    cliFound: Object.fromEntries(cli) as Record<CliProviderKind, boolean>,
    keySet: Object.fromEntries(keys) as Record<ApiProviderKind, boolean>,
  };
}
