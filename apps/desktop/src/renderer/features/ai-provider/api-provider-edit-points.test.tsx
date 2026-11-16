// @vitest-environment jsdom
import {
  apiProviderKindSchema,
  appSettingsSchema,
  chatEngineSchema,
  selectableEngineKindSchema,
  settingsPageSchema,
  summaryApiKindSchema,
  summaryProviderIdSchema,
  summaryProviderSchema,
  summarySetupKindSchema,
  transcriptionProviderKindSchema,
} from '@vozella/contracts';
import {
  API_ENGINES,
  API_ENGINE_LIST,
  CLOUD_TRANSCRIPTION_KINDS,
  readSettings,
  TRANSCRIPTION_PROVIDER_LIST,
} from '@vozella/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import uiEn from '../../i18n/locales/ui.en.json';
import uiEs from '../../i18n/locales/ui.es.json';
import { ENGINE_LABEL } from '../chat/chat-prompts-view';
import { SETTINGS_KIND } from '../chat/model-choice';
import { ENGINE_GROUPS } from '../settings/engine-status';
import { API_KINDS, API_NAME_KEYS, isApiKind, KEY_PROVIDER_NAME_KEYS } from './api-engines';
import { ProviderMark } from './ProviderMark';

/**
 * What a new API key engine needs. The one declaration is its row in core's `API_ENGINES`
 * (packages/core/src/settings/api-engine-table.ts); every list, enum, name map, group and order in
 * core, contracts and the renderer derives from it. These pieces cannot derive and stay manual;
 * each `describe` below is one of them and fails naming the engine that lacks it:
 *
 *   1. packages/contracts/src/api-providers.ts: the engine's kind and id (contracts cannot import
 *      core, so the list is restated once and every schema derives from it).
 *   2. Its model setting: the field in core's `AppSettings` and `FIELDS` (the persisted order,
 *      checked in core's `api-provider-derivation.test.ts`) and in contracts' `appSettingsSchema`.
 *   3. Its product name in both locale files (`ui.en.json`, `ui.es.json`).
 *   4. Its mark in `ProviderMark.tsx`.
 *
 * Tests that pin the order the user sees (the Settings list, the setup wizard, the wizard e2e)
 * name each engine on purpose and change with the product, not with the code.
 *
 * A provider that only transcribes (Deepgram) is not an API key engine. Its one declaration is its
 * row in core's `TRANSCRIPTION_PROVIDERS` (packages/core/src/settings/transcription-provider-table.ts),
 * plus its row in `CLOUD_TRANSCRIPTION_ENGINES`. The last `describe` blocks list what it needs by
 * hand (its kind in contracts, its name in both locales, its mark) and prove it is in no summary,
 * chat or setup wizard list.
 */

afterEach(cleanup);

const kinds: readonly string[] = Object.keys(API_ENGINES);
const ids: readonly string[] = API_ENGINE_LIST.map((engine) => engine.providerId);

/** The kinds or ids on one side only, so a failure names them. */
const difference = (contracts: readonly string[], core: readonly string[]) => ({
  missingInContracts: core.filter((value) => !contracts.includes(value)),
  extraInContracts: contracts.filter((value) => !core.includes(value)),
});
const inParity = { missingInContracts: [], extraInContracts: [] };

describe('edit point 1: the kinds and ids restated in contracts', () => {
  it('lists the same kinds as the core table, in its order', () => {
    expect(difference(apiProviderKindSchema.options, kinds)).toEqual(inParity);
    expect(apiProviderKindSchema.options).toEqual(kinds);
  });

  it('lists the same ids as the core table, in its order', () => {
    const apiIds = chatEngineSchema.options.filter(
      (id) => !['claude-code', 'codex', 'local'].includes(id),
    );
    expect(difference(apiIds, ids)).toEqual(inParity);
    expect(apiIds).toEqual(ids);
  });

  it('derives every schema that lists API engines from them', () => {
    expect(summaryApiKindSchema.options).toEqual(kinds);
    expect(summaryProviderSchema.options).toEqual([
      'Local',
      'ClaudeCode',
      'Codex',
      'Xai',
      ...kinds,
    ]);
    expect(selectableEngineKindSchema.options).toEqual(['Local', 'ClaudeCode', 'Codex', ...kinds]);
    expect(summarySetupKindSchema.options).toEqual(['Local', 'ClaudeCode', 'Codex', ...kinds]);
    expect(summaryProviderIdSchema.options).toEqual(['local', 'claude-code', 'codex', ...ids]);
    expect(chatEngineSchema.options).toEqual(['claude-code', 'codex', 'local', ...ids]);
    expect(Object.keys(settingsPageSchema.shape.api.shape)).toEqual(kinds);
  });
});

describe('edit point 2: the model setting of each engine', () => {
  it.each(API_ENGINE_LIST)('$kind: $modelSetting crosses IPC', (engine) => {
    expect(Object.keys(appSettingsSchema.shape)).toContain(engine.modelSetting);
  });

  it('the settings schema carries exactly the fields core persists', () => {
    expect(Object.keys(appSettingsSchema.shape).sort()).toEqual(
      Object.keys(readSettings({})).sort(),
    );
  });
});

describe('edit point 3: the product name in both locales', () => {
  const english: Readonly<Record<string, string>> = uiEn;
  const spanish: Readonly<Record<string, string>> = uiEs;

  it.each(API_ENGINE_LIST)('$kind: $nameKey has text in English and Spanish', (engine) => {
    expect(english[engine.nameKey] ?? '').not.toBe('');
    expect(spanish[engine.nameKey] ?? '').not.toBe('');
  });
});

describe('edit point 4: the mark of each engine', () => {
  it.each(API_ENGINE_LIST)('$kind draws a mark', (engine) => {
    const { container } = render(<ProviderMark kind={engine.kind} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('renderer tables derived from the core table', () => {
  it('offers the API engines in the table order, under their names', () => {
    expect(API_KINDS).toEqual(kinds);
    expect(API_NAME_KEYS).toEqual(
      Object.fromEntries(API_ENGINE_LIST.map((engine) => [engine.kind, engine.nameKey])),
    );
    expect(kinds.every(isApiKind)).toBe(true);
    expect(isApiKind('Local')).toBe(false);
  });

  it('lists them in the API key group of Settings', () => {
    expect(ENGINE_GROUPS.map((group) => group.engines.map((engine) => engine.kind))).toEqual([
      ['Local'],
      ['ClaudeCode', 'Codex'],
      kinds,
    ]);
    expect(ENGINE_GROUPS[2]?.engines.map((engine) => engine.name)).toEqual(
      API_ENGINE_LIST.map((engine) => engine.nameKey),
    );
  });

  it.each(API_ENGINE_LIST)('$providerId opens $kind in Settings under its name', (engine) => {
    expect(SETTINGS_KIND[engine.providerId]).toBe(engine.kind);
    expect(ENGINE_LABEL[engine.providerId]).toBe(engine.nameKey);
  });

  it('names every chat engine and nothing else', () => {
    expect(Object.keys(SETTINGS_KIND).sort()).toEqual([...chatEngineSchema.options].sort());
    expect(Object.keys(ENGINE_LABEL).sort()).toEqual([...chatEngineSchema.options].sort());
  });
});

describe('a transcription-only provider: its manual edit points', () => {
  const english: Readonly<Record<string, string>> = uiEn;
  const spanish: Readonly<Record<string, string>> = uiEs;

  it('contracts restates the kinds of the core table, in its order', () => {
    expect(transcriptionProviderKindSchema.options).toEqual(
      TRANSCRIPTION_PROVIDER_LIST.map((provider) => provider.kind),
    );
  });

  it('every one can be chosen to transcribe', () => {
    for (const provider of TRANSCRIPTION_PROVIDER_LIST) {
      expect(CLOUD_TRANSCRIPTION_KINDS as readonly string[]).toContain(provider.kind);
    }
  });

  it.each(TRANSCRIPTION_PROVIDER_LIST)(
    '$kind: $nameKey has text in English and Spanish, and the key row finds it',
    (provider) => {
      expect(english[provider.nameKey] ?? '').not.toBe('');
      expect(spanish[provider.nameKey] ?? '').not.toBe('');
      expect(KEY_PROVIDER_NAME_KEYS[provider.kind]).toBe(provider.nameKey);
    },
  );

  it.each(TRANSCRIPTION_PROVIDER_LIST)('$kind draws a mark', (provider) => {
    const { container } = render(<ProviderMark kind={provider.kind} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('a transcription-only provider is never a summary, chat or setup engine', () => {
  const lower = (values: readonly string[]): string[] => values.map((value) => value.toLowerCase());

  it.each(TRANSCRIPTION_PROVIDER_LIST)('$kind is in no schema that lists engines', (provider) => {
    const name = provider.kind.toLowerCase();
    for (const schema of [
      apiProviderKindSchema,
      summaryApiKindSchema,
      summaryProviderSchema,
      selectableEngineKindSchema,
      summarySetupKindSchema,
      summaryProviderIdSchema,
      chatEngineSchema,
    ]) {
      expect(lower(schema.options)).not.toContain(name);
    }
    expect(lower(Object.keys(settingsPageSchema.shape.api.shape))).not.toContain(name);
  });

  it.each(TRANSCRIPTION_PROVIDER_LIST)(
    '$kind is in no list the app offers engines from: Settings, the chat picker, the wizard',
    (provider) => {
      const name = provider.kind.toLowerCase();
      // `API_KINDS` is the list the setup wizard and the engine chooser draw.
      expect(lower(API_KINDS)).not.toContain(name);
      expect(isApiKind(provider.kind)).toBe(false);
      expect(lower(Object.keys(API_NAME_KEYS))).not.toContain(name);
      expect(
        lower(ENGINE_GROUPS.flatMap((group) => group.engines.map((e) => e.kind))),
      ).not.toContain(name);
      expect(lower(Object.keys(SETTINGS_KIND))).not.toContain(name);
      expect(lower(Object.values(SETTINGS_KIND))).not.toContain(name);
      expect(lower(Object.keys(ENGINE_LABEL))).not.toContain(name);
      expect(Object.values(ENGINE_LABEL) as string[]).not.toContain(provider.nameKey);
    },
  );
});
