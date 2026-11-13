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
  apiModelLabels,
  apiSetupGap,
  estimateTokens,
  isApiEngine,
  isChatModelId,
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
    expect(API_ENGINES.OpenAi.resolveModel(blank)).toBe('gpt-6-astra');
    expect(API_ENGINES.Anthropic.resolveModel(blank)).toBe('claude-opus-5-5');
    expect(API_ENGINES.Gemini.resolveModel(blank)).toBe('gemini-3.8-flash');
    expect(API_ENGINES.OpenAiCompatible.resolveModel(blank)).toBe('');
    const saved = readSettings({
      selectedOpenAiModelId: 'gpt-5',
      selectedOpenAiCompatibleModelId: ' llama3.1 ',
      selectedAnthropicModelId: '   ',
    });
    expect(API_ENGINES.OpenAi.resolveModel(saved)).toBe('gpt-5');
    expect(API_ENGINES.OpenAiCompatible.resolveModel(saved)).toBe('llama3.1');
    expect(API_ENGINES.Anthropic.resolveModel(saved)).toBe('claude-opus-5-5');
  });

  it('suggests the current models from each provider catalog (checked 2026-11-10)', () => {
    expect(API_ENGINES.OpenAi.models).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ]);
    expect(API_ENGINES.Anthropic.models).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-2',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(API_ENGINES.Gemini.models).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
  });

  it('gives every suggested model a readable name, and nothing else', () => {
    for (const engine of API_ENGINE_LIST) {
      expect(Object.keys(engine.modelNames)).toEqual(engine.models);
    }
    expect(API_ENGINES.Anthropic.modelNames['claude-opus-5-5']).toBe('Claude Opus 5.5');
    expect(API_ENGINES.Anthropic.modelNames['claude-fable-5-2']).toBe('Claude Fable 5.2');
    expect(API_ENGINES.OpenAi.modelNames['gpt-6-astra']).toBe('GPT-6 Astra');
    expect(API_ENGINES.OpenAi.modelNames['gpt-6.1-sol']).toBe('GPT-6.1 Sol');
    expect(API_ENGINES.Gemini.modelNames['gemini-3.8-flash']).toBe('Gemini 3.8 Flash');
    expect(API_ENGINES.Gemini.modelNames['gemini-3.5-flash-lite']).toBe('Gemini 3.5 Flash-Lite');
  });

  it('labels the known ids of a list and leaves the others to show their id', () => {
    expect(
      apiModelLabels(API_ENGINES.Anthropic, ['claude-opus-5-5', 'claude-custom', 'gpt-6-astra']),
    ).toEqual({ 'claude-opus-5-5': 'Claude Opus 5.5' });
    expect(apiModelLabels(API_ENGINES.OpenAiCompatible, ['llama3.1'])).toEqual({});
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

describe('isChatModelId', () => {
  it('keeps text chat models', () => {
    for (const id of [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-luna',
      'claude-opus-5-5',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
    ]) {
      expect(isChatModelId(id), id).toBe(true);
    }
  });

  it('drops embedding, image, audio, realtime, moderation and other non-chat models', () => {
    for (const id of [
      'text-embedding-3-small',
      'gemini-embedding-2',
      'gpt-image-2.6-sunburst',
      'gemini-3.5-flash-image',
      'gemini-nano-banana-2.1',
      'imagen-4.0-generate',
      'dall-e-3',
      'gpt-realtime-2.1-mini',
      'gpt-live-1',
      'gemini-3.1-flash-live-preview',
      'gpt-transcribe',
      'gemini-3.5-transcribe',
      'gpt-realtime-whisper',
      'whisper-1',
      'gpt-audio-1.5',
      'gemini-2.5-flash-native-audio-preview-09-2025',
      'tts-1',
      'gemini-3.1-flash-tts-preview',
      'omni-moderation-latest',
      'gpt-realtime-translate',
      'gpt-6-cyber',
      'gpt-rosalind-research',
      'gpt-5.3-codex',
      'o3-deep-research',
      'computer-use-preview',
      'gemini-omni-3-flash',
      'lyria-2',
      'veo-3.1-generate',
      'gemini-robotics-er-1.5',
      'antigravity-preview-1',
      'aqa',
    ]) {
      expect(isChatModelId(id), id).toBe(false);
    }
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
