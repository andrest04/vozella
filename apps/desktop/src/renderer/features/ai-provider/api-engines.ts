import type { ApiProviderKindDto } from '@vozella/contracts';
import type { StringKey } from '../../i18n/translate';

/** The API key engines (BYOK) in the order the app offers them. */
export const API_KINDS: readonly ApiProviderKindDto[] = [
  'OpenAi',
  'Anthropic',
  'Gemini',
  'OpenAiCompatible',
];

/** Catalog key of each API engine's product name. */
export const API_NAME_KEYS: Readonly<Record<ApiProviderKindDto, StringKey>> = {
  OpenAi: 'Ui_ApiOpenAiName',
  Anthropic: 'Ui_ApiAnthropicName',
  Gemini: 'Ui_ApiGeminiName',
  OpenAiCompatible: 'Ui_ApiOpenAiCompatibleName',
};

export const isApiKind = (kind: string): kind is ApiProviderKindDto =>
  (API_KINDS as readonly string[]).includes(kind);

/** What an API engine still needs, as the sentence that points the user to Settings. */
export const apiSetupMessageKey = (reason: string): StringKey =>
  reason === 'key-missing' ? 'Ui_ApiKeyMissing' : 'Ui_ApiSetupIncomplete';
