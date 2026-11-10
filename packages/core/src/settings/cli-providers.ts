import {
  resolveClaudeEffort,
  resolveClaudeModelId,
  resolveCodexEffort,
  resolveCodexModelId,
  type AppSettings,
  type SummaryProviderKind,
} from '../library/settings';
import type { ProviderId } from '../summaries/provider';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS } from './inference-options';

export type CliProviderKind = Extract<SummaryProviderKind, 'ClaudeCode' | 'Codex'>;

/** Settings fields that hold a string per engine. */
type StringSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string | null ? K : never;
}[keyof AppSettings];

/**
 * What the app knows about one CLI engine. The same engine has a name in each vocabulary: the
 * saved summary-provider `kind`, the chat and summaries `providerId`, and the `executable` on PATH
 * (which the Settings page also uses as the key of the model and effort pickers). These names are
 * stored on disk and sent over IPC, so they never change; this table only says how they line up.
 */
export interface CliEngine {
  readonly kind: CliProviderKind;
  readonly providerId: Exclude<ProviderId, 'local'>;
  readonly executable: 'claude' | 'codex';
  /** The product name in errors and status lines. */
  readonly displayName: string;
  /** Attached images are files the engine opens itself with a tool, not inputs on the argv. */
  readonly readsImagesFromDisk: boolean;
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly resolveModel: (settings: AppSettings) => string;
  readonly resolveEffort: (settings: AppSettings) => string;
  readonly modelSetting: StringSettingKey;
  readonly effortSetting: StringSettingKey;
}

/** The single table of CLI engines. Add or change an engine here. */
export const CLI_ENGINES = {
  ClaudeCode: {
    kind: 'ClaudeCode',
    providerId: 'claude-code',
    executable: 'claude',
    displayName: 'Claude Code',
    readsImagesFromDisk: true,
    models: CLAUDE_MODELS,
    efforts: CLAUDE_EFFORTS,
    resolveModel: resolveClaudeModelId,
    resolveEffort: resolveClaudeEffort,
    modelSetting: 'selectedClaudeModelId',
    effortSetting: 'selectedClaudeEffort',
  },
  Codex: {
    kind: 'Codex',
    providerId: 'codex',
    executable: 'codex',
    displayName: 'Codex',
    readsImagesFromDisk: false,
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
    resolveModel: resolveCodexModelId,
    resolveEffort: resolveCodexEffort,
    modelSetting: 'selectedCodexModelId',
    effortSetting: 'selectedCodexEffort',
  },
} as const satisfies Readonly<Record<CliProviderKind, CliEngine>>;

export const CLI_ENGINE_LIST: readonly CliEngine[] = Object.values(CLI_ENGINES);

export type CliProviderId = CliEngine['providerId'];
export type CliExecutable = CliEngine['executable'];

export const isCliProvider = (kind: SummaryProviderKind): kind is CliProviderKind =>
  CLI_ENGINE_LIST.some((engine) => engine.kind === kind);

/** The program name looked up on PATH. Other kinds are not CLI backed. */
export function cliExecutableName(kind: SummaryProviderKind): CliExecutable {
  if (!isCliProvider(kind))
    throw new RangeError('Only ClaudeCode and Codex are CLI-backed providers.');
  return CLI_ENGINES[kind].executable;
}

/** The CLI engine behind a provider id; undefined for local or an engine that does not say. */
export const cliEngineByProviderId = (providerId: ProviderId | undefined): CliEngine | undefined =>
  CLI_ENGINE_LIST.find((engine) => engine.providerId === providerId);

export const isCliEngine = (providerId: ProviderId | undefined): boolean =>
  cliEngineByProviderId(providerId) !== undefined;

/** Whether the engine opens attached images from its working directory (Claude Code does). */
export const readsImagesFromDisk = (providerId: ProviderId | undefined): boolean =>
  cliEngineByProviderId(providerId)?.readsImagesFromDisk ?? false;

export function cliEngineByExecutable(executable: CliExecutable): CliEngine {
  const engine = CLI_ENGINE_LIST.find((e) => e.executable === executable);
  if (engine === undefined) throw new RangeError(`Unknown CLI executable: ${executable}`);
  return engine;
}

/** The saved summary-provider kind for a chat or summaries provider id. */
export const summaryKindOf = (providerId: ProviderId): 'Local' | CliProviderKind =>
  cliEngineByProviderId(providerId)?.kind ?? 'Local';

/** Catalog keys for the line under the provider radios. */
export const CLI_STATUS_KEYS = { found: 'Status_CliOnPath', missing: 'Status_CliMissing' } as const;
