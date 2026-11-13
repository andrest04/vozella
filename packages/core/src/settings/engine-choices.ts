import type { ChatEngine } from '../chat/user-prompts';
import {
  isProviderAvailable,
  resolveSummaryProviderKind,
  type AppSettings,
  type SettingsStore,
} from '../library';
import { isApiProvider, isCliProvider } from '../library/settings';
import { API_ENGINES, apiModelLabels, apiModelOptions, chatEngineOfKind } from './api-providers';
import { CLI_ENGINES } from './cli-providers';
import {
  engineStatuses,
  readEngineAccess,
  type EngineAccessDeps,
  type SummaryEngineReadiness,
  type SummaryEngineStatus,
} from './engine-readiness';
import { optionsIncluding } from './inference-options';
import type { LocalModelsService, ModelRows } from './local-models';

export interface EngineModelOption {
  /** CLI: the model alias. API: the model id. Local: the catalog file name. */
  readonly id: string;
  /** The readable name; the id itself when there is none. */
  readonly label: string;
}

/** One engine as chat's model picker shows it. */
export interface EngineChoice {
  readonly engine: ChatEngine;
  readonly readiness: SummaryEngineReadiness;
  /** CLI: its models. API: suggestions plus the saved id. Local: the downloaded models only. */
  readonly models: readonly EngineModelOption[];
  /** CLI only; empty for the others. */
  readonly effortOptions: readonly string[];
  /** The model Settings would use, or null when there is none. */
  readonly defaultModel: string | null;
  /** The effort Settings would use (CLI only), else null. */
  readonly defaultEffort: string | null;
}

export interface EngineChoices {
  /** The Settings engine; null when the saved one was removed (Xai). */
  readonly defaultEngine: ChatEngine | null;
  /** Every selectable engine, in display order. */
  readonly engines: readonly EngineChoice[];
}

export interface EngineChoicesDeps extends EngineAccessDeps {
  readonly store: SettingsStore;
  /** Only the model rows are read, without a hardware profile: no fit rating is needed. */
  readonly models: Pick<LocalModelsService, 'rows'>;
}

const sameAsId = (id: string): EngineModelOption => ({ id, label: id });

function choiceFor(
  status: SummaryEngineStatus,
  settings: AppSettings,
  models: ModelRows,
): EngineChoice {
  const { kind, readiness } = status;
  const engine = chatEngineOfKind(kind);
  if (isCliProvider(kind)) {
    const cli = CLI_ENGINES[kind];
    const model = cli.resolveModel(settings);
    const effort = cli.resolveEffort(settings);
    return {
      engine,
      readiness,
      models: optionsIncluding(cli.models, model).map(sameAsId),
      effortOptions: optionsIncluding(cli.efforts, effort),
      defaultModel: model,
      defaultEffort: effort,
    };
  }
  if (isApiProvider(kind)) {
    const api = API_ENGINES[kind];
    const model = api.resolveModel(settings);
    const ids = apiModelOptions(api, model);
    const labels = apiModelLabels(api, ids);
    return {
      engine,
      readiness,
      models: ids.map((id) => ({ id, label: labels[id] ?? id })),
      effortOptions: [],
      defaultModel: model === '' ? null : model,
      defaultEffort: null,
    };
  }
  const downloaded = models.rows.filter((row) => row.downloaded);
  return {
    engine,
    readiness,
    models: downloaded.map((row) => ({ id: row.fileName, label: row.displayName })),
    effortOptions: [],
    defaultModel: downloaded.find((row) => row.active)?.fileName ?? null,
    defaultEffort: null,
  };
}

/**
 * What chat's model picker offers: each engine's readiness, models and efforts, with the Settings
 * values as defaults. Cheaper than the Settings page: no hardware detection, nothing written.
 */
export async function readEngineChoices(deps: EngineChoicesDeps): Promise<EngineChoices> {
  const settings = await deps.store.load();
  const [models, access] = await Promise.all([deps.models.rows(null), readEngineAccess(deps)]);
  const statuses = engineStatuses({
    settings,
    cliFound: access.cliFound,
    cliModel: {
      ClaudeCode: CLI_ENGINES.ClaudeCode.resolveModel(settings),
      Codex: CLI_ENGINES.Codex.resolveModel(settings),
    },
    keySet: access.keySet,
    models,
  });
  const saved = resolveSummaryProviderKind(settings);
  return {
    defaultEngine: isProviderAvailable(saved) ? chatEngineOfKind(saved) : null,
    engines: statuses.map((status) => choiceFor(status, settings, models)),
  };
}
