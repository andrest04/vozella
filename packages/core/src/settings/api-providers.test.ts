import { describe, expect, it } from 'vitest';
import { attachmentBudgetFor, LOCAL_ATTACHMENT_CHARS } from '../chat/attachments';
import { CLI_CONTEXT_BUDGET, contextBudgetFor } from '../chat/context-packer';
import { CLI_PRIOR_TURN_LIMITS, priorTurnLimitsFor } from '../chat/prompt-builder';
import { isApiProvider, isCliProvider, readSettings, SUMMARY_PROVIDERS } from '../library';
import { supportsWebSearch } from '../live-ask/web-policy';
import { PROVIDER_IDS } from '../summaries/provider';
import {
  API_ENGINE_LIST,
  API_ENGINES,
  apiEngineByProviderId,
  apiSetupGap,
  estimateTokens,
  isApiEngine,
  isRemoteEngine,
  summaryKindOf,
} from './api-providers';
import { isCliEngine, readsImagesFromDisk } from './cli-providers';

const API_IDS = ['openai', 'anthropic', 'gemini', 'openai-compatible'] as const;

describe('API_ENGINES', () => {
  it('lists the four key engines with their ids, protocol and default base URL', () => {
    expect(
      API_ENGINE_LIST.map((e) => [e.kind, e.providerId, e.protocol, e.defaultBaseUrl]),
    ).toEqual([
      ['OpenAi', 'openai', 'openai-chat', 'https://api.openai.com/v1'],
      ['Anthropic', 'anthropic', 'anthropic-messages', 'https://api.anthropic.com/v1'],
      [
        'Gemini',
        'gemini',
        'openai-chat',
        'https://generativelanguage.googleapis.com/v1beta/openai',
      ],
      ['OpenAiCompatible', 'openai-compatible', 'openai-chat', null],
    ]);
  });

  it('keys every engine by its own kind, with ids the summaries layer knows', () => {
    for (const engine of API_ENGINE_LIST) {
      expect(API_ENGINES[engine.kind]).toBe(engine);
      expect(PROVIDER_IDS).toContain(engine.providerId);
      expect(SUMMARY_PROVIDERS).toContain(engine.kind);
    }
  });

  it('needs a key everywhere except the compatible endpoint', () => {
    expect(API_ENGINE_LIST.filter((e) => e.requiresKey).map((e) => e.kind)).toEqual([
      'OpenAi',
      'Anthropic',
      'Gemini',
    ]);
  });

  it('defaults the model per engine and lets a saved one win', () => {
    const blank = readSettings({});
    expect(API_ENGINES.OpenAi.resolveModel(blank)).toBe('gpt-5-mini');
    expect(API_ENGINES.Anthropic.resolveModel(blank)).toBe('claude-sonnet-5-5');
    expect(API_ENGINES.Gemini.resolveModel(blank)).toBe('gemini-2.5-flash');
    expect(API_ENGINES.OpenAiCompatible.resolveModel(blank)).toBe('');
    const saved = readSettings({
      selectedOpenAiModelId: 'gpt-5',
      selectedOpenAiCompatibleModelId: ' llama3.1 ',
      selectedAnthropicModelId: '   ',
    });
    expect(API_ENGINES.OpenAi.resolveModel(saved)).toBe('gpt-5');
    expect(API_ENGINES.OpenAiCompatible.resolveModel(saved)).toBe('llama3.1');
    expect(API_ENGINES.Anthropic.resolveModel(saved)).toBe('claude-sonnet-5-5');
  });

  it('offers a suggested list that holds the default model', () => {
    for (const engine of API_ENGINE_LIST) {
      if (engine.defaultModel !== null) expect(engine.models).toContain(engine.defaultModel);
    }
    expect(API_ENGINES.OpenAiCompatible.models).toEqual([]);
  });

  it('reads the compatible base URL from settings and the others from the table', () => {
    expect(API_ENGINES.OpenAiCompatible.resolveBaseUrl(readSettings({}))).toBeNull();
    expect(
      API_ENGINES.OpenAiCompatible.resolveBaseUrl(
        readSettings({ openAiCompatibleBaseUrl: 'http://localhost:11434/v1' }),
      ),
    ).toBe('http://localhost:11434/v1');
    expect(API_ENGINES.OpenAi.resolveBaseUrl(readSettings({}))).toBe('https://api.openai.com/v1');
  });
});

describe('apiSetupGap', () => {
  it('names what is missing, base URL first, then key, then model', () => {
    const blank = readSettings({});
    expect(apiSetupGap(API_ENGINES.OpenAi, blank, false)).toBe('key-missing');
    expect(apiSetupGap(API_ENGINES.OpenAi, blank, true)).toBeNull();
    expect(apiSetupGap(API_ENGINES.OpenAiCompatible, blank, false)).toBe('base-url-missing');
    const withUrl = readSettings({ openAiCompatibleBaseUrl: 'http://localhost:1234/v1' });
    expect(apiSetupGap(API_ENGINES.OpenAiCompatible, withUrl, false)).toBe('model-missing');
    const ready = readSettings({
      openAiCompatibleBaseUrl: 'http://localhost:1234/v1',
      selectedOpenAiCompatibleModelId: 'qwen',
    });
    expect(apiSetupGap(API_ENGINES.OpenAiCompatible, ready, false)).toBeNull();
  });
});

describe('estimateTokens', () => {
  it('counts about four characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('API engine lookups', () => {
  it('isApiProvider knows the four kinds only', () => {
    for (const engine of API_ENGINE_LIST) {
      expect(isApiProvider(engine.kind)).toBe(true);
      expect(isCliProvider(engine.kind)).toBe(false);
    }
    expect(isApiProvider('ClaudeCode')).toBe(false);
    expect(isApiProvider('Local')).toBe(false);
    expect(isApiProvider(null)).toBe(false);
  });

  it('finds an engine by provider id and maps it back to its saved kind', () => {
    expect(apiEngineByProviderId('gemini')).toBe(API_ENGINES.Gemini);
    expect(apiEngineByProviderId('codex')).toBeUndefined();
    expect(summaryKindOf('openai')).toBe('OpenAi');
    expect(summaryKindOf('openai-compatible')).toBe('OpenAiCompatible');
    expect(summaryKindOf('codex')).toBe('Codex');
    expect(summaryKindOf('local')).toBe('Local');
  });

  it('counts CLI and API engines as remote, never local', () => {
    for (const id of API_IDS) {
      expect(isApiEngine(id)).toBe(true);
      expect(isCliEngine(id)).toBe(false);
      expect(isRemoteEngine(id)).toBe(true);
    }
    expect(isRemoteEngine('claude-code')).toBe(true);
    expect(isRemoteEngine('local')).toBe(false);
    expect(isRemoteEngine(undefined)).toBe(false);
  });
});

describe('remote budgets for API engines', () => {
  it.each(API_IDS)('%s gets the large context, history and file budgets', (id) => {
    expect(contextBudgetFor(id)).toBe(CLI_CONTEXT_BUDGET);
    expect(priorTurnLimitsFor(id)).toBe(CLI_PRIOR_TURN_LIMITS);
    expect(attachmentBudgetFor(id, 0)).toBeGreaterThan(LOCAL_ATTACHMENT_CHARS);
    expect(attachmentBudgetFor(id, 0)).toBe(attachmentBudgetFor('codex', 0));
  });

  it('API engines do not read images from disk and cannot search the web', () => {
    for (const id of API_IDS) expect(readsImagesFromDisk(id)).toBe(false);
    for (const engine of API_ENGINE_LIST) expect(supportsWebSearch(engine.kind)).toBe(false);
  });
});
