import { describe, expect, it } from 'vitest';
import { readSettings } from '../library';
import { PROVIDER_IDS } from '../summaries/provider';
import {
  CLI_ENGINE_LIST,
  CLI_ENGINES,
  cliEngineByExecutable,
  cliEngineByProviderId,
  cliExecutableName,
  isCliEngine,
  isCliProvider,
  readsImagesFromDisk,
  summaryKindOf,
} from './cli-providers';
import { CLAUDE_MODELS, CODEX_EFFORTS } from './inference-options';

describe('CLI_ENGINES', () => {
  it('lists Claude Code and Codex with their ids in every vocabulary', () => {
    expect(CLI_ENGINE_LIST.map((e) => [e.kind, e.providerId, e.executable])).toEqual([
      ['ClaudeCode', 'claude-code', 'claude'],
      ['Codex', 'codex', 'codex'],
    ]);
  });

  it('keys every engine by its own kind', () => {
    for (const engine of CLI_ENGINE_LIST) expect(CLI_ENGINES[engine.kind]).toBe(engine);
  });

  it('uses provider ids the summaries layer knows', () => {
    for (const engine of CLI_ENGINE_LIST) expect(PROVIDER_IDS).toContain(engine.providerId);
  });

  it('carries the model and effort choices and settings fields per engine', () => {
    expect(CLI_ENGINES.ClaudeCode.models).toBe(CLAUDE_MODELS);
    expect(CLI_ENGINES.Codex.efforts).toBe(CODEX_EFFORTS);
    expect(CLI_ENGINES.ClaudeCode.modelSetting).toBe('selectedClaudeModelId');
    expect(CLI_ENGINES.Codex.effortSetting).toBe('selectedCodexEffort');
  });

  it('resolves saved model and effort, falling back to the defaults', () => {
    const blank = readSettings({});
    const saved = { ...blank, selectedCodexModelId: 'gpt-x', selectedCodexEffort: 'high' };
    expect(CLI_ENGINES.Codex.resolveModel(saved)).toBe('gpt-x');
    expect(CLI_ENGINES.Codex.resolveEffort(saved)).toBe('high');
    expect(CLI_ENGINES.ClaudeCode.resolveModel(blank)).not.toBe('');
  });
});

describe('isCliProvider', () => {
  it('is true only for the CLI summary kinds', () => {
    expect(isCliProvider('ClaudeCode')).toBe(true);
    expect(isCliProvider('Codex')).toBe(true);
    expect(isCliProvider('Local')).toBe(false);
    expect(isCliProvider('Xai')).toBe(false);
  });
});

describe('cliExecutableName', () => {
  it('maps each CLI kind to its program name', () => {
    expect(cliExecutableName('ClaudeCode')).toBe('claude');
    expect(cliExecutableName('Codex')).toBe('codex');
  });

  it('refuses kinds that are not CLI backed', () => {
    expect(() => cliExecutableName('Local')).toThrow(RangeError);
  });
});

describe('isCliEngine', () => {
  it('is true for the CLI provider ids only', () => {
    expect(isCliEngine('claude-code')).toBe(true);
    expect(isCliEngine('codex')).toBe(true);
    expect(isCliEngine('local')).toBe(false);
    expect(isCliEngine(undefined)).toBe(false);
  });
});

describe('readsImagesFromDisk', () => {
  it('is true only for Claude Code, which opens images with its Read tool', () => {
    expect(readsImagesFromDisk('claude-code')).toBe(true);
    expect(readsImagesFromDisk('codex')).toBe(false);
    expect(readsImagesFromDisk('local')).toBe(false);
  });
});

describe('lookups', () => {
  it('finds an engine by provider id', () => {
    expect(cliEngineByProviderId('codex')).toBe(CLI_ENGINES.Codex);
    expect(cliEngineByProviderId('local')).toBeUndefined();
  });

  it('finds an engine by executable', () => {
    expect(cliEngineByExecutable('claude')).toBe(CLI_ENGINES.ClaudeCode);
    expect(cliEngineByExecutable('codex')).toBe(CLI_ENGINES.Codex);
  });

  it('maps a provider id to its summary kind', () => {
    expect(summaryKindOf('claude-code')).toBe('ClaudeCode');
    expect(summaryKindOf('codex')).toBe('Codex');
    expect(summaryKindOf('local')).toBe('Local');
  });
});
