import { describe, expect, it, vi } from 'vitest';
import { InMemorySettingsStore } from '../library';
import type { ApiProviderKind } from '../library/settings';
import { chatEngineOfKind } from './api-providers';
import { readEngineChoices } from './engine-choices';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS } from './inference-options';
import { LocalModelsService } from './local-models';
import type { LocalModelStore } from './ports';
import { SUMMARY_MODELS } from './summary-models';

const [ONE_B, THREE_B, MICRO] = SUMMARY_MODELS as unknown as [
  (typeof SUMMARY_MODELS)[number],
  (typeof SUMMARY_MODELS)[number],
  (typeof SUMMARY_MODELS)[number],
];

function rig(
  options: {
    cli?: Record<string, boolean>;
    keys?: readonly ApiProviderKind[];
    downloaded?: readonly string[];
  } = {},
) {
  const store = new InMemorySettingsStore();
  const files = new Set(options.downloaded ?? []);
  const modelStore: LocalModelStore = {
    isDownloaded: (m) => Promise.resolve(files.has(m.fileName)),
    download: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  };
  const models = new LocalModelsService({
    store: modelStore,
    settings: store,
    notify: () => undefined,
  });
  const rows = vi.spyOn(models, 'rows');
  const probed: string[] = [];
  const deps = {
    store,
    cli: {
      isOnPath: (name: string) => {
        probed.push(name);
        return Promise.resolve(options.cli?.[name] ?? false);
      },
    },
    apiKeys: {
      has: (kind: ApiProviderKind) => Promise.resolve(options.keys?.includes(kind) ?? false),
    },
    models,
  };
  return { store, deps, rows, probed, modelStore };
}

describe('readEngineChoices', () => {
  it('lists the seven engines in display order with the Settings engine as the default', async () => {
    const t = rig({ cli: { claude: true }, keys: ['OpenAi'] });
    await t.store.update({ selectedSummaryProvider: 'ClaudeCode' });
    const choices = await readEngineChoices(t.deps);
    expect(choices.defaultEngine).toBe('claude-code');
    expect(choices.engines.map((e) => [e.engine, e.readiness])).toEqual([
      ['local', 'needs-model'],
      ['claude-code', 'ready'],
      ['codex', 'cli-missing'],
      ['openai', 'ready'],
      ['anthropic', 'needs-key'],
      ['gemini', 'needs-key'],
      ['openai-compatible', 'needs-server'],
    ]);
    expect(t.probed.sort()).toEqual(['claude', 'codex']);
  });

  it('CLI engines offer their models and efforts with the Settings values as defaults', async () => {
    const t = rig({ cli: { claude: true, codex: true } });
    await t.store.update({ selectedClaudeModelId: 'opus', selectedClaudeEffort: 'high' });
    const { engines } = await readEngineChoices(t.deps);
    const claude = engines.find((e) => e.engine === 'claude-code')!;
    expect(claude.models).toEqual(CLAUDE_MODELS.map((id) => ({ id, label: id })));
    expect(claude.effortOptions).toEqual(CLAUDE_EFFORTS);
    expect([claude.defaultModel, claude.defaultEffort]).toEqual(['opus', 'high']);
    const codex = engines.find((e) => e.engine === 'codex')!;
    expect(codex.models.map((m) => m.id)).toEqual(CODEX_MODELS);
    expect(codex.effortOptions).toEqual(CODEX_EFFORTS);
    expect([codex.defaultModel, codex.defaultEffort]).toEqual(['gpt-5.6', 'low']);
  });

  it('API engines offer suggested models with readable names and no effort', async () => {
    const t = rig({ keys: ['Anthropic'] });
    await t.store.update({ selectedAnthropicModelId: 'my-custom-model' });
    const { engines } = await readEngineChoices(t.deps);
    const anthropic = engines.find((e) => e.engine === 'anthropic')!;
    expect(anthropic.models[0]).toEqual({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' });
    expect(anthropic.models.at(-1)).toEqual({ id: 'my-custom-model', label: 'my-custom-model' });
    expect(anthropic.effortOptions).toEqual([]);
    expect([anthropic.defaultModel, anthropic.defaultEffort]).toEqual(['my-custom-model', null]);
    const compatible = engines.find((e) => e.engine === 'openai-compatible')!;
    expect([compatible.models, compatible.defaultModel]).toEqual([[], null]);
  });

  it('Local offers only downloaded models, by display name, and never detects hardware', async () => {
    const t = rig({ downloaded: [ONE_B.fileName, MICRO.fileName] });
    await t.store.update({ selectedSummaryModelId: MICRO.fileName });
    const { engines, defaultEngine } = await readEngineChoices(t.deps);
    const local = engines[0]!;
    expect(defaultEngine).toBe('local');
    expect(local.readiness).toBe('ready');
    expect(local.models).toEqual([
      { id: ONE_B.fileName, label: ONE_B.displayName },
      { id: MICRO.fileName, label: MICRO.displayName },
    ]);
    expect(local.models.map((m) => m.id)).not.toContain(THREE_B.fileName);
    expect([local.defaultModel, local.defaultEffort, local.effortOptions]).toEqual([
      MICRO.fileName,
      null,
      [],
    ]);
    // No hardware profile: the fit ratings are not needed, so no detection runs.
    expect(t.rows).toHaveBeenCalledWith(null);
    expect(t.modelStore.download).not.toHaveBeenCalled();
  });

  it('a CLI probe that fails reads as not found; the removed Xai default is no default', async () => {
    const t = rig();
    t.deps.cli.isOnPath = () => Promise.reject(new Error('probe failed'));
    await t.store.update({ selectedSummaryProvider: 'Xai' });
    const choices = await readEngineChoices(t.deps);
    expect(choices.defaultEngine).toBeNull();
    expect(choices.engines[1]!.readiness).toBe('cli-missing');
  });
});

describe('chatEngineOfKind', () => {
  it('is the reverse of summaryKindOf', () => {
    expect(chatEngineOfKind('Local')).toBe('local');
    expect(chatEngineOfKind('ClaudeCode')).toBe('claude-code');
    expect(chatEngineOfKind('Codex')).toBe('codex');
    expect(chatEngineOfKind('OpenAiCompatible')).toBe('openai-compatible');
  });
});
