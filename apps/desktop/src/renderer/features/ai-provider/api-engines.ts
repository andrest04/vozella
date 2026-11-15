import type {
  ApiKeyKindDto,
  ApiProviderKindDto,
  ChatEngineDto,
  TranscriptionProviderKindDto,
} from '@vozella/contracts';
import {
  API_ENGINE_LIST,
  TRANSCRIPTION_PROVIDER_LIST,
  type ApiEngine,
  type ApiProviderId,
} from '@vozella/core';
import type { StringKey } from '../../i18n/translate';

/*
 * Everything here follows core's `API_ENGINES` table, so a new engine needs no edit in this file.
 * The annotations tie the table to the channel types and to the string catalog: a kind or id the
 * contracts do not list, or a name key missing from the catalog, is a type error.
 */

/** The API key engines (BYOK) in the order the app offers them. */
export const API_KINDS: readonly ApiProviderKindDto[] = API_ENGINE_LIST.map(
  (engine) => engine.kind,
);

/** Catalog key of each API engine's product name. */
export const API_NAME_KEYS = Object.fromEntries(
  API_ENGINE_LIST.map((engine): [ApiProviderKindDto, StringKey] => [engine.kind, engine.nameKey]),
) as Readonly<Record<ApiProviderKindDto, StringKey>>;

/**
 * Catalog key of the product name of everything that holds a key: the API engines, and the
 * providers that only transcribe (core's `TRANSCRIPTION_PROVIDERS`). The key row and the
 * transcription section name a provider from here. The lists above stay the API engines only, so
 * a transcription-only provider is never offered for summaries or chat.
 */
export const KEY_PROVIDER_NAME_KEYS: Readonly<Record<ApiKeyKindDto, StringKey>> = {
  ...API_NAME_KEYS,
  ...(Object.fromEntries(
    TRANSCRIPTION_PROVIDER_LIST.map((provider): [TranscriptionProviderKindDto, StringKey] => [
      provider.kind,
      provider.nameKey,
    ]),
  ) as Readonly<Record<TranscriptionProviderKindDto, StringKey>>),
};

/** One value per API key engine, keyed by its chat engine id. */
export const byApiEngineId = <T>(
  value: (engine: ApiEngine) => T,
): Readonly<Record<ApiProviderId, T>> =>
  Object.fromEntries(
    API_ENGINE_LIST.map((engine): [ChatEngineDto, T] => [engine.providerId, value(engine)]),
  ) as Readonly<Record<ApiProviderId, T>>;

export const isApiKind = (kind: string): kind is ApiProviderKindDto =>
  (API_KINDS as readonly string[]).includes(kind);

/** What an API engine still needs, as the sentence that points the user to Settings. */
export const apiSetupMessageKey = (reason: string): StringKey =>
  reason === 'key-missing' ? 'Ui_ApiKeyMissing' : 'Ui_ApiSetupIncomplete';
