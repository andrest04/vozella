import type { SettingsStore } from '../library/ports';
import {
  isApiProvider,
  isProviderAvailable,
  type AppSettings,
  type SummaryProviderKind,
} from '../library/settings';
import { API_ENGINES, type ApiEngine } from '../settings/api-providers';
import { CLI_ENGINES } from '../settings/cli-providers';
import {
  createClaudeCodeProvider,
  createClaudeCodeWebSearchProvider,
} from './claude-code-provider';
import type { CliProcessRunner } from './cli-failure';
import { createCodexProvider, createCodexWebSearchProvider } from './codex-provider';
import type { SummaryProvider } from './provider';

/**
 * Builds the provider for an API key engine from the settings read for this call. Core does no
 * HTTP: the platform supplies the adapter, which reads the key from its `ApiKeyStore`.
 */
export type ApiProviderBuilder = (
  engine: ApiEngine,
  settings: AppSettings,
) => SummaryProvider | Promise<SummaryProvider>;

export interface SummaryProviderFactoryDeps {
  /** The single settings reader (B2): every provider is built from `settings.load()`. */
  readonly settings: SettingsStore;
  readonly runner: CliProcessRunner;
  /** Builds the local provider for a model file. The platform shares one host behind it (B3). */
  readonly createLocal: (modelPath: string) => SummaryProvider;
  /** Builds the OpenAI, Anthropic, Gemini and compatible providers (BYOK). */
  readonly apiProviderBuilder: ApiProviderBuilder;
  /** The fake native build answers every kind with a double. Null falls through to the real one. */
  readonly override?: (kind: SummaryProviderKind) => SummaryProvider | null;
}

export interface CreateProviderOptions {
  /** Required for Local. */
  readonly modelPath?: string | null;
  /** The live-answer path only (item 143). Summaries never ask for it. */
  readonly webSearch?: boolean;
}

/**
 * `AppServices.CreateSummaryProvider`. A new provider on every call, with model and effort read
 * from the current settings, so a change in Settings is seen by the next call. Local is the one
 * provider that is cheap to rebuild because the heavy server lives in the shared host.
 */
export class SummaryProviderFactory {
  constructor(private readonly deps: SummaryProviderFactoryDeps) {}

  async create(
    kind: SummaryProviderKind,
    options: CreateProviderOptions = {},
  ): Promise<SummaryProvider> {
    if (!isProviderAvailable(kind)) {
      throw new RangeError(`The ${kind} provider was removed.`);
    }
    const overridden = this.deps.override?.(kind) ?? null;
    if (overridden !== null) return overridden;
    if (kind === 'Local') {
      if (options.modelPath === undefined || options.modelPath === null) {
        throw new TypeError('A model path is required for the local provider.');
      }
      return this.deps.createLocal(options.modelPath);
    }
    const settings = await this.deps.settings.load();
    // API engines have no web search (live answers keep it CLI-only), so the flag is ignored.
    if (isApiProvider(kind)) return this.deps.apiProviderBuilder(API_ENGINES[kind], settings);
    const webSearch = options.webSearch === true;
    const engine = CLI_ENGINES[kind];
    const cliOptions = {
      model: engine.resolveModel(settings),
      effort: engine.resolveEffort(settings),
    };
    if (kind === 'ClaudeCode') {
      const make = webSearch ? createClaudeCodeWebSearchProvider : createClaudeCodeProvider;
      return make(this.deps.runner, cliOptions);
    }
    const make = webSearch ? createCodexWebSearchProvider : createCodexProvider;
    return make(this.deps.runner, cliOptions);
  }
}
