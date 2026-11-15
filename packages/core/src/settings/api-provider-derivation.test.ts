import { describe, expect, it } from 'vitest';
import { CHAT_ENGINES } from '../chat/user-prompts';
import {
  API_PROVIDER_KINDS,
  SUMMARY_PROVIDERS,
  isApiProvider,
  readSettings,
  serializeSettings,
} from '../library/settings';
import { summaryCaption } from '../recording/setup-snapshot';
import { PROVIDER_IDS } from '../summaries/provider';
import { API_ENGINES, API_ENGINE_LIST } from './api-providers';

/**
 * `API_ENGINES` is the one declaration of an API key engine. Every other list of API kinds or ids
 * in core follows it, so a new engine is one table entry plus its settings field. Each check names
 * the engine it misses.
 */

const kinds = Object.keys(API_ENGINES);
const ids = Object.values(API_ENGINES).map((engine) => engine.providerId);

describe('the API engine table', () => {
  it('keeps the engines and their order', () => {
    // Pins today's order: it is the order of the Settings list, the wizard and the chat picker.
    expect(kinds).toEqual(['OpenAi', 'Anthropic', 'Gemini', 'Groq', 'OpenAiCompatible']);
    expect(ids).toEqual(['openai', 'anthropic', 'gemini', 'groq', 'openai-compatible']);
  });

  it.each(Object.entries(API_ENGINES))('files %s under its own kind', (key, engine) => {
    expect(engine.kind).toBe(key);
  });

  it('has one provider id and one model setting per engine', () => {
    expect(new Set(ids).size).toBe(ids.length);
    const settings = API_ENGINE_LIST.map((engine) => engine.modelSetting);
    expect(new Set(settings).size).toBe(settings.length);
  });
});

describe('lists derived from the API engine table', () => {
  it('API_PROVIDER_KINDS is the table kinds, in order', () => {
    expect([...API_PROVIDER_KINDS]).toEqual(kinds);
  });

  it('SUMMARY_PROVIDERS is Local, the CLI engines, Xai, then the table kinds', () => {
    expect([...SUMMARY_PROVIDERS]).toEqual(['Local', 'ClaudeCode', 'Codex', 'Xai', ...kinds]);
  });

  it('PROVIDER_IDS is local, the CLI engines, then the table ids', () => {
    expect([...PROVIDER_IDS]).toEqual(['local', 'claude-code', 'codex', ...ids]);
  });

  it('CHAT_ENGINES is the CLI engines, local, then the table ids', () => {
    expect([...CHAT_ENGINES]).toEqual(['claude-code', 'codex', 'local', ...ids]);
  });

  it.each(API_ENGINE_LIST)('$kind is an API provider with its own caption', (engine) => {
    expect(isApiProvider(engine.kind)).toBe(true);
    expect(summaryCaption(engine.kind, null)).toEqual({ key: engine.nameKey, args: [] });
  });
});

describe('the settings field of each API engine (a manual edit point)', () => {
  it.each(API_ENGINE_LIST)('$kind: $modelSetting is read from the file', (engine) => {
    expect(Object.keys(readSettings({}))).toContain(engine.modelSetting);
    expect(readSettings({ [engine.modelSetting]: 'a-model' })[engine.modelSetting]).toBe('a-model');
  });

  it.each(API_ENGINE_LIST)('$kind: $modelSetting is written only once set', (engine) => {
    expect(Object.keys(JSON.parse(serializeSettings({})) as object)).not.toContain(
      engine.modelSetting,
    );
    const saved = JSON.parse(serializeSettings({ [engine.modelSetting]: 'a-model' })) as Record<
      string,
      unknown
    >;
    expect(saved[engine.modelSetting]).toBe('a-model');
  });

  it('keeps the order of the settings file', () => {
    // Persisted order: Groq was added after the compatible engine's fields and stays there.
    const persisted = [
      'selectedOpenAiModelId',
      'selectedAnthropicModelId',
      'selectedGeminiModelId',
      'selectedOpenAiCompatibleModelId',
      'openAiCompatibleBaseUrl',
      'selectedGroqModelId',
    ];
    expect(Object.keys(readSettings({})).filter((key) => persisted.includes(key))).toEqual(
      persisted,
    );
  });
});
