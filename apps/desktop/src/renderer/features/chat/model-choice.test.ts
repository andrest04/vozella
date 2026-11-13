import type { ChatEngineChoicesDto } from '@vozella/contracts';
import { describe, expect, it } from 'vitest';
import {
  choiceFor,
  defaultChoice,
  effortKey,
  isPickable,
  pickerGroups,
  readableModel,
  sendOverride,
} from './model-choice';

const CHOICES: ChatEngineChoicesDto = {
  defaultEngine: 'claude-code',
  engines: [
    {
      engine: 'local',
      readiness: 'needs-model',
      models: [],
      effortOptions: [],
      defaultModel: null,
      defaultEffort: null,
    },
    {
      engine: 'claude-code',
      readiness: 'ready',
      models: [
        { id: 'sonnet', label: 'sonnet' },
        { id: 'opus', label: 'opus' },
      ],
      effortOptions: ['low', 'medium', 'high'],
      defaultModel: 'sonnet',
      defaultEffort: 'low',
    },
    {
      engine: 'codex',
      readiness: 'cli-missing',
      models: [{ id: 'gpt-5.6', label: 'gpt-5.6' }],
      effortOptions: ['low', 'medium'],
      defaultModel: 'gpt-5.6',
      defaultEffort: 'medium',
    },
    {
      engine: 'openai',
      readiness: 'ready',
      models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      effortOptions: [],
      defaultModel: 'gpt-4o',
      defaultEffort: null,
    },
  ],
};

const names = (engine: string): string => engine;

describe('chat model choice', () => {
  it('starts from the Settings engine, model and effort', () => {
    expect(defaultChoice(CHOICES)).toEqual({
      engine: 'claude-code',
      model: 'sonnet',
      effort: 'low',
    });
    expect(defaultChoice({ ...CHOICES, defaultEngine: null })).toBeNull();
  });

  it('sends no override while the choice is the default', () => {
    expect(sendOverride(defaultChoice(CHOICES), CHOICES)).toEqual({});
    expect(sendOverride(null, CHOICES)).toEqual({});
  });

  it('sends engine, model and effort once the choice moved away from the default', () => {
    expect(sendOverride({ engine: 'claude-code', model: 'opus', effort: 'low' }, CHOICES)).toEqual({
      engine: 'claude-code',
      model: 'opus',
      effort: 'low',
    });
    expect(sendOverride({ engine: 'openai', model: 'gpt-4o', effort: null }, CHOICES)).toEqual({
      engine: 'openai',
      model: 'gpt-4o',
    });
  });

  it('keeps the effort inside one engine and resets it to the default on another engine', () => {
    const claude = CHOICES.engines[1];
    const openai = CHOICES.engines[3];
    if (!claude || !openai) throw new Error('fixture');
    expect(
      choiceFor(claude, 'opus', { engine: 'claude-code', model: 'sonnet', effort: 'high' }),
    ).toEqual({
      engine: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    expect(choiceFor(claude, 'opus', { engine: 'openai', model: 'gpt-4o', effort: null })).toEqual({
      engine: 'claude-code',
      model: 'opus',
      effort: 'low',
    });
    expect(choiceFor(openai, 'gpt-4o', null)).toEqual({
      engine: 'openai',
      model: 'gpt-4o',
      effort: null,
    });
  });

  it('offers ready engines with models, and Local whenever a model is downloaded', () => {
    expect(isPickable(CHOICES.engines[1]!)).toBe(true);
    expect(isPickable(CHOICES.engines[2]!)).toBe(false);
    expect(isPickable(CHOICES.engines[0]!)).toBe(false);
    expect(
      isPickable({ ...CHOICES.engines[0]!, models: [{ id: 'gemma.gguf', label: 'Gemma 3 4B' }] }),
    ).toBe(true);
  });

  it('groups engines by what the user brings and filters by engine or model name', () => {
    const all = pickerGroups(CHOICES, '', names);
    expect(all.map((g) => g.id)).toEqual(['device', 'subscription', 'apiKey']);
    expect(all[1]?.engines.map((e) => e.engine)).toEqual(['claude-code', 'codex']);

    const opus = pickerGroups(CHOICES, ' OPUS ', names);
    expect(opus).toHaveLength(1);
    expect(opus[0]?.engines[0]?.models.map((m) => m.id)).toEqual(['opus']);

    const byEngine = pickerGroups(CHOICES, 'codex', names);
    expect(byEngine[0]?.engines.map((e) => e.engine)).toEqual(['codex']);

    expect(pickerGroups(CHOICES, 'nothing', names)).toEqual([]);
  });

  it('names CLI aliases readably and keeps API labels', () => {
    expect(readableModel('claude-code', { id: 'sonnet', label: 'sonnet' })).toBe('Sonnet');
    expect(readableModel('codex', { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' })).toBe('GPT-5.6-sol');
    expect(readableModel('openai', { id: 'gpt-4o', label: 'gpt-4o' })).toBe('gpt-4o');
  });

  it('names known effort levels and leaves unknown ones as they are', () => {
    expect(effortKey('xhigh')).toBe('Ui_ChatEffortXHigh');
    expect(effortKey('max')).toBe('Ui_ChatEffortMax');
    expect(effortKey('turbo')).toBeNull();
  });
});
