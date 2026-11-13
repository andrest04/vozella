import type {
  ChatEngineChoiceDto,
  ChatEngineChoicesDto,
  ChatEngineDto,
  ChatModelOptionDto,
} from '@vozella/contracts';
import type { StringKey } from '../../i18n/translate';
import type { EngineKind } from '../settings/engine-status';

/** What the chat answers with: an engine, its model and, for a CLI, its effort. */
export interface ModelChoice {
  readonly engine: ChatEngineDto;
  readonly model: string | null;
  readonly effort: string | null;
}

/** The part of `chat.send` the picker fills: nothing while the choice is the Settings default. */
export interface ChoiceOverride {
  readonly engine?: ChatEngineDto;
  readonly model?: string;
  readonly effort?: string;
}

/** Chat engine ids as Settings names them, to open the matching engine row there. */
export const SETTINGS_KIND: Readonly<Record<ChatEngineDto, EngineKind>> = {
  local: 'Local',
  'claude-code': 'ClaudeCode',
  codex: 'Codex',
  openai: 'OpenAi',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  'openai-compatible': 'OpenAiCompatible',
};

const engineOf = (
  choices: ChatEngineChoicesDto,
  engine: ChatEngineDto | null,
): ChatEngineChoiceDto | undefined => choices.engines.find((entry) => entry.engine === engine);

/** The Settings engine with its model and effort; null when Settings names none. */
export function defaultChoice(choices: ChatEngineChoicesDto): ModelChoice | null {
  const entry = engineOf(choices, choices.defaultEngine);
  if (!entry) return null;
  return { engine: entry.engine, model: entry.defaultModel, effort: entry.defaultEffort };
}

const sameChoice = (a: ModelChoice, b: ModelChoice): boolean =>
  a.engine === b.engine && a.model === b.model && a.effort === b.effort;

/** The send override: empty for the default, so a default send is the same request as before. */
export function sendOverride(
  choice: ModelChoice | null,
  choices: ChatEngineChoicesDto | null,
): ChoiceOverride {
  if (!choice || !choices) return {};
  const fallback = defaultChoice(choices);
  if (fallback && sameChoice(choice, fallback)) return {};
  return {
    engine: choice.engine,
    ...(choice.model === null ? {} : { model: choice.model }),
    ...(choice.effort === null ? {} : { effort: choice.effort }),
  };
}

/**
 * The choice after picking `modelId` of `entry`. The effort stays inside one engine and falls back
 * to the engine's default when the engine changes.
 */
export function choiceFor(
  entry: ChatEngineChoiceDto,
  modelId: string,
  current: ModelChoice | null,
): ModelChoice {
  const keepEffort =
    current?.engine === entry.engine &&
    current.effort !== null &&
    entry.effortOptions.includes(current.effort);
  return {
    engine: entry.engine,
    model: modelId,
    effort: keepEffort ? current.effort : entry.defaultEffort,
  };
}

/** Ready engines with a model, and Local as soon as one model is downloaded. */
export function isPickable(entry: ChatEngineChoiceDto): boolean {
  if (entry.models.length === 0) return false;
  return entry.readiness === 'ready' || entry.engine === 'local';
}

export type PickerGroupId = 'device' | 'subscription' | 'apiKey';

export const GROUP_CAPTION: Readonly<Record<PickerGroupId, StringKey>> = {
  device: 'Ui_ProviderGroupDevice',
  subscription: 'Ui_ProviderGroupSubscription',
  apiKey: 'Ui_ProviderGroupApiKey',
};

const GROUP_OF: Readonly<Record<ChatEngineDto, PickerGroupId>> = {
  local: 'device',
  'claude-code': 'subscription',
  codex: 'subscription',
  openai: 'apiKey',
  anthropic: 'apiKey',
  gemini: 'apiKey',
  'openai-compatible': 'apiKey',
};

const GROUP_ORDER: readonly PickerGroupId[] = ['device', 'subscription', 'apiKey'];

export interface PickerEngine {
  readonly entry: ChatEngineChoiceDto;
  readonly engine: ChatEngineDto;
  readonly pickable: boolean;
  /** The models to list: every model, or the ones the search matched. */
  readonly models: readonly ChatModelOptionDto[];
}

export interface PickerGroup {
  readonly id: PickerGroupId;
  readonly engines: readonly PickerEngine[];
}

/**
 * The engines under their group, in the order main sends them. A search matches an engine name
 * (its models all stay) or a model name (only those stay); an engine with no match drops out.
 */
export function pickerGroups(
  choices: ChatEngineChoicesDto,
  query: string,
  engineName: (engine: ChatEngineDto) => string,
): readonly PickerGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = (text: string): boolean => text.toLowerCase().includes(needle);
  const engines: PickerEngine[] = [];
  for (const entry of choices.engines) {
    const pickable = isPickable(entry);
    const all = pickable ? entry.models : [];
    if (needle === '' || matches(engineName(entry.engine))) {
      engines.push({ entry, engine: entry.engine, pickable, models: all });
      continue;
    }
    const models = all.filter(
      (model) => matches(readableModel(entry.engine, model)) || matches(model.id),
    );
    if (models.length > 0) engines.push({ entry, engine: entry.engine, pickable, models });
  }
  return GROUP_ORDER.map((id) => ({
    id,
    engines: engines.filter((item) => GROUP_OF[item.engine] === id),
  })).filter((group) => group.engines.length > 0);
}

const isCli = (engine: ChatEngineDto): boolean => engine === 'claude-code' || engine === 'codex';

/** A CLI alias reads as a name (`sonnet` → Sonnet, `gpt-5.6` → GPT-5.6); other labels stay. */
export function readableModel(engine: ChatEngineDto, model: ChatModelOptionDto): string {
  const label = model.label === '' ? model.id : model.label;
  if (!isCli(engine) || label !== model.id) return label;
  if (label.startsWith('gpt-')) return `GPT-${label.slice(4)}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const EFFORT_KEYS: Readonly<Record<string, StringKey>> = {
  low: 'Ui_ChatEffortLow',
  medium: 'Ui_ChatEffortMedium',
  high: 'Ui_ChatEffortHigh',
  xhigh: 'Ui_ChatEffortXHigh',
  max: 'Ui_ChatEffortMax',
};

/** The readable name of an effort level; null for a level this build does not know. */
export function effortKey(effort: string): StringKey | null {
  return Object.hasOwn(EFFORT_KEYS, effort) ? (EFFORT_KEYS[effort] ?? null) : null;
}

/** What an engine that is not ready needs, as the action that opens it in Settings. */
export function setupActionKey(entry: ChatEngineChoiceDto): StringKey {
  switch (entry.readiness) {
    case 'cli-missing':
      return 'Ui_ChatModelInstall';
    case 'needs-key':
      return 'Ui_ChatModelAddKey';
    case 'needs-model':
      return entry.engine === 'local' ? 'Ui_ChatModelDownload' : 'Ui_ChatModelSetUp';
    default:
      return 'Ui_ChatModelSetUp';
  }
}
