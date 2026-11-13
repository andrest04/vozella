import { resolveUiLanguage, type UiLanguageTag } from '../i18n/ui-language';
import { gpuOffloadFor } from '../summaries/llama-backend';
import {
  resolveClaudeEffort,
  resolveClaudeModelId,
  resolveCodexEffort,
  resolveCodexModelId,
  isProviderAvailable,
  resolveSummaryProviderKind,
  type AppSettings,
  type SettingsStore,
  type SummaryProviderKind,
} from '../library';
import type { ApiKeyStore } from '../api-keys/api-key-store';
import {
  API_PROVIDER_KINDS,
  isCliProvider,
  type ApiProviderKind,
  type CliProviderKind,
} from '../library/settings';
import { API_ENGINES, apiModelLabels } from './api-providers';
import { cliExecutableName } from './cli-providers';
import { engineStatuses, type SummaryEngineStatus } from './engine-readiness';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  optionsIncluding,
} from './inference-options';
import { resolveMeetingLanguageCode, resolveSummaryLanguageCode } from './languages';
import type { LocalModelsService, ModelRows } from './local-models';
import type { PendingNotice, SettingsNotices } from './notices';
import type { CliPathProbe, HardwareProbe, SettingsCapabilities } from './ports';
import type { HardwareProfile } from './summary-models';

export type ProviderNotice = 'xai-removed';

export type CliStatus = 'detected' | 'missing';

export interface ProviderOptions {
  readonly model: string;
  readonly effort: string;
  /** The list, plus the stored value when it is not on it (B13). */
  readonly modelOptions: readonly string[];
  readonly effortOptions: readonly string[];
}

/** One API key engine on the page. The key itself never leaves the main process. */
export interface ApiEngineOptions {
  readonly keySet: boolean;
  /** The saved model, else the default; empty when the engine has none. */
  readonly model: string;
  /** Suggestions, plus the saved model when it is not on the list (B13). */
  readonly modelOptions: readonly string[];
  /** Readable names of the options the engine knows, by id. An id without one shows as itself. */
  readonly modelLabels: Readonly<Record<string, string>>;
  /** The endpoint of the compatible engine; null for the others or when none is saved. */
  readonly baseUrl: string | null;
}

/** Everything the Settings page needs from the local phase of its load. Nothing here touches the network. */
export interface SettingsPageSnapshot {
  readonly settings: AppSettings;
  readonly uiLanguage: UiLanguageTag;
  readonly provider: SummaryProviderKind;
  readonly claude: ProviderOptions;
  readonly codex: ProviderOptions;
  readonly api: Readonly<Record<ApiProviderKind, ApiEngineOptions>>;
  /** For the selected CLI provider only; null for Local and a removed provider. */
  readonly cliStatus: CliStatus | null;
  /** Every selectable engine, in display order, with whether it could answer if picked now. */
  readonly engines: readonly SummaryEngineStatus[];
  readonly transcriptionLanguage: string;
  readonly summaryLanguage: string;
  /** Null when the machine could not be read. */
  readonly hardware: HardwareProfile | null;
  readonly models: ModelRows;
  /** 'xai-removed' when the saved provider is Xai, which no longer exists. The page asks for another. */
  readonly providerNotice: ProviderNotice | null;
  readonly capabilities: SettingsCapabilities;
  readonly notices: readonly PendingNotice[];
}

export interface SettingsPageDeps {
  readonly store: SettingsStore;
  readonly osLanguages: () => readonly string[];
  readonly hardware: HardwareProbe;
  readonly models: LocalModelsService;
  readonly cli: CliPathProbe;
  readonly notices: SettingsNotices;
  readonly capabilities: SettingsCapabilities;
  /**
   * Whether the llama runtime in use offloads to the GPU; undefined until one is picked. The fit
   * ratings and the recommendation follow it, so a CPU-only runtime does not count the VRAM.
   */
  readonly activeGpuOffload?: () => boolean | undefined;
  /** Whether a key is saved per API engine. Without it, no key reads as set. */
  readonly apiKeys?: Pick<ApiKeyStore, 'has'>;
}

/** Builds the page. Reads, never writes: opening Settings changes no setting. */
export class SettingsPageService {
  constructor(private readonly deps: SettingsPageDeps) {}

  /**
   * The local phase. Settings and the hardware are read together. A settings file that cannot be
   * read rejects, so the page can say so (B18); a machine that cannot be read is only a missing
   * fit rating.
   */
  async load(): Promise<SettingsPageSnapshot> {
    const [settings, hardware] = await Promise.all([
      this.deps.store.load(),
      this.deps.hardware.detect().catch(() => null),
    ]);
    const provider = resolveSummaryProviderKind(settings);
    // Both CLIs are probed every time, together, so the list can show each one without picking it.
    const [models, claudeFound, codexFound, api] = await Promise.all([
      this.deps.models.rows(
        hardware,
        hardware ? { gpuOffload: gpuOffloadFor(hardware, this.deps.activeGpuOffload?.()) } : {},
      ),
      // A probe that fails reads as not found: it must not keep the page from loading.
      this.isCliFound('ClaudeCode').catch(() => false),
      this.isCliFound('Codex').catch(() => false),
      this.apiOptions(settings),
    ]);
    const cliFound: Record<CliProviderKind, boolean> = {
      ClaudeCode: claudeFound,
      Codex: codexFound,
    };
    const cliStatus = isCliProvider(provider) ? cliStatusOf(cliFound[provider]) : null;
    const claudeModel = resolveClaudeModelId(settings);
    const claudeEffort = resolveClaudeEffort(settings);
    const codexModel = resolveCodexModelId(settings);
    const codexEffort = resolveCodexEffort(settings);
    const engines = engineStatuses({
      settings,
      cliFound,
      cliModel: { ClaudeCode: claudeModel, Codex: codexModel },
      keySet: {
        OpenAi: api.OpenAi.keySet,
        Anthropic: api.Anthropic.keySet,
        Gemini: api.Gemini.keySet,
        OpenAiCompatible: api.OpenAiCompatible.keySet,
      },
      models,
    });
    return {
      settings,
      uiLanguage: resolveUiLanguage(settings.uiLanguage, this.deps.osLanguages()),
      provider,
      claude: {
        model: claudeModel,
        effort: claudeEffort,
        modelOptions: optionsIncluding(CLAUDE_MODELS, claudeModel),
        effortOptions: optionsIncluding(CLAUDE_EFFORTS, claudeEffort),
      },
      codex: {
        model: codexModel,
        effort: codexEffort,
        modelOptions: optionsIncluding(CODEX_MODELS, codexModel),
        effortOptions: optionsIncluding(CODEX_EFFORTS, codexEffort),
      },
      api,
      cliStatus,
      engines,
      transcriptionLanguage: resolveMeetingLanguageCode(settings.transcriptionLanguage),
      summaryLanguage: resolveSummaryLanguageCode(settings.summaryLanguage),
      hardware,
      models,
      providerNotice: isProviderAvailable(provider) ? null : 'xai-removed',
      capabilities: this.deps.capabilities,
      notices: this.deps.notices.pending(),
    };
  }

  private async apiOptions(
    settings: AppSettings,
  ): Promise<Readonly<Record<ApiProviderKind, ApiEngineOptions>>> {
    const entries = await Promise.all(
      API_PROVIDER_KINDS.map(async (kind) => {
        const engine = API_ENGINES[kind];
        const model = engine.resolveModel(settings);
        const keySet = (await this.deps.apiKeys?.has(kind)) ?? false;
        const modelOptions = model === '' ? engine.models : optionsIncluding(engine.models, model);
        const options: ApiEngineOptions = {
          keySet,
          model,
          modelOptions,
          modelLabels: apiModelLabels(engine, modelOptions),
          baseUrl: engine.defaultBaseUrl === null ? engine.resolveBaseUrl(settings) : null,
        };
        return [kind, options] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<ApiProviderKind, ApiEngineOptions>;
  }

  /** Looks for the program again, so installing it while Settings is open is noticed (B15). */
  async detectCli(kind: SummaryProviderKind): Promise<CliStatus | null> {
    if (!isCliProvider(kind)) return null;
    return cliStatusOf(await this.isCliFound(kind));
  }

  private isCliFound(kind: CliProviderKind): Promise<boolean> {
    return this.deps.cli.isOnPath(cliExecutableName(kind));
  }
}

const cliStatusOf = (found: boolean): CliStatus => (found ? 'detected' : 'missing');
