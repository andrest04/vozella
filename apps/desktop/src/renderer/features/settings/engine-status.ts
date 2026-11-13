import type { SettingsPageDto, SummaryEngineReadinessDto } from '@vozella/contracts';
import type { StringKey } from '../../i18n/translate';
import { isApiKind } from '../ai-provider/api-engines';

export type EngineKind = SettingsPageDto['engines'][number]['kind'];

/**
 * The engines in three groups, by what the user brings: nothing (this PC), a subscription and its
 * CLI, or their own API key. The order inside a group is fixed; Grok is not offered.
 */
export const ENGINE_GROUPS: readonly {
  readonly caption: StringKey;
  readonly engines: readonly { readonly kind: EngineKind; readonly name: StringKey }[];
}[] = [
  {
    caption: 'Ui_ProviderGroupDevice',
    engines: [{ kind: 'Local', name: 'Settings_ProviderLocal.Text' }],
  },
  {
    caption: 'Ui_ProviderGroupSubscription',
    engines: [
      { kind: 'ClaudeCode', name: 'Settings_ProviderClaude.Text' },
      { kind: 'Codex', name: 'Settings_ProviderCodex.Text' },
    ],
  },
  {
    caption: 'Ui_ProviderGroupApiKey',
    engines: [
      { kind: 'OpenAi', name: 'Ui_ApiOpenAiName' },
      { kind: 'Anthropic', name: 'Ui_ApiAnthropicName' },
      { kind: 'Gemini', name: 'Ui_ApiGeminiName' },
      { kind: 'OpenAiCompatible', name: 'Ui_ApiOpenAiCompatibleName' },
    ],
  },
];

export const isEngineKind = (kind: string): kind is EngineKind =>
  ENGINE_GROUPS.some((group) => group.engines.some((engine) => engine.kind === kind));

/** The short status beside an engine's name. */
export type EngineStatus =
  'in-use' | 'ready' | 'key-saved' | 'not-found' | 'needs-key' | 'not-set-up';

export const ENGINE_STATUS_KEYS: Readonly<Record<EngineStatus, StringKey>> = {
  'in-use': 'Ui_SummaryEngineInUse',
  ready: 'Ui_SummaryEngineReady',
  'key-saved': 'Ui_SummaryEngineKeySaved',
  'not-found': 'Ui_SummaryEngineNotFound',
  'needs-key': 'Ui_SummaryEngineNeedsKey',
  'not-set-up': 'Ui_SummaryEngineNotSetUp',
};

/**
 * In use wins; otherwise what the readiness means for this kind of engine. A ready API engine says
 * its key is saved, unless it needs none (a local OpenAI-compatible server). Null when the page did
 * not report the engine.
 */
export function engineStatus(
  kind: EngineKind,
  readiness: SummaryEngineReadinessDto | null,
  options: { readonly inUse: boolean; readonly keySet: boolean },
): EngineStatus | null {
  if (options.inUse) return 'in-use';
  switch (readiness) {
    case 'ready':
      return isApiKind(kind) && options.keySet ? 'key-saved' : 'ready';
    case 'cli-missing':
      return 'not-found';
    case 'needs-key':
      return 'needs-key';
    case 'needs-server':
    case 'needs-model':
      return 'not-set-up';
    default:
      return null;
  }
}
