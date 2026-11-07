import { describe, expect, it } from 'vitest';
import { readSettings, resolveSummaryLanguage, resolveTranscriptionLanguage } from '../library';
import { cliExecutableName } from './cli-providers';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  optionsIncluding,
} from './inference-options';
import {
  SUMMARY_LANGUAGES,
  TRANSCRIPTION_LANGUAGES,
  engineLocaleFor,
  resolveMeetingLanguageCode,
  resolveSummaryLanguageCode,
} from './languages';
import {
  NOTE_TEMPLATE_BUILT_INS,
  instructionsFor,
  noteTemplateOptions,
  normalizeTemplateId,
} from './note-templates';
import {
  FIT_LABEL_KEYS,
  LEGACY_SUMMARY_MODELS,
  SUMMARY_MODELS,
  findSummaryModel,
  formatModelSize,
  rateFor,
  recommendedFor,
  serverArgsFor,
  type HardwareProfile,
  type RateOptions,
  type SummaryModelInfo,
} from './summary-models';

const defaults = readSettings({});

describe('language catalogs', () => {
  it('transcription: auto first, then the nine languages, in order', () => {
    expect(TRANSCRIPTION_LANGUAGES.map((l) => l.code)).toEqual([
      'auto',
      'en',
      'es',
      'pt',
      'fr',
      'de',
      'it',
      'nl',
      'ja',
      'zh',
    ]);
  });

  it('summary: es then en', () => {
    expect(SUMMARY_LANGUAGES.map((l) => l.code)).toEqual(['es', 'en']);
  });

  it('every label key is a CoreStrings language key', () => {
    for (const entry of [...TRANSCRIPTION_LANGUAGES, ...SUMMARY_LANGUAGES]) {
      expect(entry.labelKey).toMatch(/^Language[A-Z][a-z]+(Detect)?$|^LanguageAutoDetect$/);
    }
  });
});

describe('engine locale mapper', () => {
  it.each([
    ['auto', 'auto'],
    ['en', 'en-US'],
    ['es', 'es-US'],
    ['pt', 'pt-BR'],
    ['fr', 'fr-FR'],
    ['de', 'de-DE'],
    ['it', 'it-IT'],
    ['nl', 'nl-NL'],
    ['ja', 'ja-JP'],
    ['zh', 'zh-CN'],
  ])('%s maps to %s', (code, locale) => {
    expect(engineLocaleFor(code)).toBe(locale);
  });

  it('trims, lowercases, maps blank and unknown codes to auto', () => {
    expect(engineLocaleFor('  ES ')).toBe('es-US');
    expect(engineLocaleFor('')).toBe('auto');
    expect(engineLocaleFor(null)).toBe('auto');
    expect(engineLocaleFor('klingon')).toBe('auto');
  });
});

describe('B6: the picker and the engine agree on case and space variants', () => {
  it.each(['ES', ' en ', 'Pt', 'AUTO'])('transcription %j', (stored) => {
    const code = resolveMeetingLanguageCode(stored);
    expect(TRANSCRIPTION_LANGUAGES.some((l) => l.code === code)).toBe(true);
    expect(code).toBe(stored.trim().toLowerCase());
    expect(engineLocaleFor(code)).toBe(engineLocaleFor(stored));
  });

  it('transcription: blank is es, an unknown code is auto like the engine', () => {
    expect(resolveMeetingLanguageCode(null)).toBe('es');
    expect(resolveMeetingLanguageCode('  ')).toBe('es');
    expect(resolveMeetingLanguageCode('klingon')).toBe('auto');
    expect(engineLocaleFor(resolveMeetingLanguageCode('klingon'))).toBe('auto');
  });

  it('summary: case variants resolve to the catalog code, unknown codes to es', () => {
    expect(resolveSummaryLanguageCode(' EN ')).toBe('en');
    expect(resolveSummaryLanguageCode('Es')).toBe('es');
    expect(resolveSummaryLanguageCode('fr')).toBe('es');
    expect(resolveSummaryLanguageCode(null)).toBe('es');
  });

  it('the settings resolvers use the same rules', () => {
    expect(resolveTranscriptionLanguage({ ...defaults, transcriptionLanguage: ' ES ' })).toBe('es');
    expect(resolveTranscriptionLanguage({ ...defaults, transcriptionLanguage: 'AUTO' })).toBe(
      'auto',
    );
    expect(resolveSummaryLanguage({ ...defaults, summaryLanguage: 'EN' })).toBe('en');
    expect(resolveSummaryLanguage({ ...defaults, summaryLanguage: 'xx' })).toBe('es');
  });
});

describe('summary model catalog', () => {
  const known = [...SUMMARY_MODELS, ...LEGACY_SUMMARY_MODELS];

  it('has the seven curated entries from four vendors', () => {
    expect(SUMMARY_MODELS.map((m) => [m.fileName, m.displayName, m.vendor])).toEqual([
      ['Llama-3.2-1B-Instruct-Q4_K_M.gguf', 'Llama 3.2 1B Instruct', 'Meta'],
      ['Llama-3.2-3B-Instruct-Q4_K_M.gguf', 'Llama 3.2 3B Instruct', 'Meta'],
      ['granite-4.0-micro-Q4_K_M.gguf', 'Granite 4.0 Micro', 'IBM'],
      ['gemma-4-E4B-it-Q4_K_M.gguf', 'Gemma 4 E4B Instruct', 'Google'],
      ['Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'Qwen3 4B Instruct 2507', 'Alibaba'],
      ['Qwen3-8B-Q4_K_M.gguf', 'Qwen3 8B', 'Alibaba'],
      ['gemma-4-12b-it-Q4_K_M.gguf', 'Gemma 4 12B Instruct', 'Google'],
    ]);
  });

  it('file names are unique across the catalog and the legacy entries', () => {
    const names = known.map((m) => m.fileName.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('is ordered by ascending minimum RAM', () => {
    const rams = SUMMARY_MODELS.map((m) => m.minRamGb);
    expect(rams).toEqual([4, 8, 8, 8, 12, 16, 16]);
    expect([...rams].sort((a, b) => a - b)).toEqual(rams);
  });

  it('ranks quality 1 (best) to 7 with no ties, from research', () => {
    const byRank = [...SUMMARY_MODELS].sort((a, b) => a.rank - b.rank).map((m) => m.displayName);
    expect(byRank).toEqual([
      'Gemma 4 12B Instruct',
      'Qwen3 8B',
      'Gemma 4 E4B Instruct',
      'Qwen3 4B Instruct 2507',
      'Granite 4.0 Micro',
      'Llama 3.2 3B Instruct',
      'Llama 3.2 1B Instruct',
    ]);
    expect(new Set(known.map((m) => m.rank)).size).toBe(known.length);
  });

  it('every URL is https, pinned to a 40-hex commit, and ends with the file name', () => {
    for (const model of known) {
      expect(model.downloadUrl, model.fileName).toMatch(
        /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//,
      );
      expect(model.downloadUrl.endsWith(`/${model.fileName}`)).toBe(true);
      expect(model.fileSizeGb).toBeGreaterThan(0);
    }
  });

  it('B18: pins the exact byte size and the SHA-256 of every file', () => {
    expect(SUMMARY_MODELS.map((m) => m.sizeBytes)).toEqual([
      807_694_464, 2_019_377_696, 2_099_502_528, 4_977_171_584, 2_497_281_120, 5_027_783_488,
      7_121_861_440,
    ]);
    for (const model of known) {
      expect(Number.isInteger(model.sizeBytes)).toBe(true);
      // The rounded GB label agrees with the byte size.
      expect(Math.round((model.sizeBytes / 1e9) * 100) / 100).toBe(model.fileSizeGb);
      expect(model.sha256, model.fileName).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(findSummaryModel('Llama-3.2-1B-Instruct-Q4_K_M.gguf')?.sha256).toBe(
      '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    );
  });

  it('only Qwen3 8B needs server flags: thinking off', () => {
    expect(known.filter((m) => m.serverArgs !== undefined).map((m) => m.fileName)).toEqual([
      'Qwen3-8B-Q4_K_M.gguf',
    ]);
    expect(serverArgsFor('Qwen3-8B-Q4_K_M.gguf')).toEqual(['--reasoning', 'off']);
    expect(serverArgsFor('gemma-4-12b-it-Q4_K_M.gguf')).toEqual([]);
    expect(serverArgsFor('nope.gguf')).toEqual([]);
    expect(serverArgsFor(null)).toEqual([]);
  });

  it('Gemma 4 E2B left the catalog but is still known as a legacy model', () => {
    expect(SUMMARY_MODELS.some((m) => m.fileName === 'gemma-4-E2B-it-Q4_K_M.gguf')).toBe(false);
    expect(LEGACY_SUMMARY_MODELS.map((m) => m.fileName)).toEqual(['gemma-4-E2B-it-Q4_K_M.gguf']);
    expect(findSummaryModel('gemma-4-E2B-it-Q4_K_M.gguf')).toMatchObject({
      legacy: true,
      sizeBytes: 3_106_738_272,
    });
    expect(SUMMARY_MODELS.every((m) => m.legacy !== true)).toBe(true);
  });

  it('B20: the catalog holds label keys, never translated text', () => {
    for (const model of known) {
      for (const key of [model.speedKey, model.qualityKey, model.useCaseKey]) {
        // Ported WinUI keys, or hand written Ui_ keys for the models added after the port.
        expect(key).toMatch(/^(Ui_)?Model(Speed|Quality|UseCase)[A-Za-z0-9]+$/);
        expect(key).not.toContain(' ');
      }
    }
    for (const key of Object.values(FIT_LABEL_KEYS)) expect(key).toMatch(/^Ui_Fit[A-Za-z]+$/);
  });

  it('labels the fit as hardware fit, not as a pick (settings polish T2)', () => {
    expect(FIT_LABEL_KEYS).toEqual({
      Recommended: 'Ui_FitRunsWell',
      MayBeSlow: 'Ui_FitMayBeSlow',
      NotRecommended: 'Ui_FitTooHeavy',
    });
  });

  it('pins every URL to the commit verified in C1, and every catalog key', () => {
    expect(known.map((m) => [m.downloadUrl, m.speedKey, m.qualityKey, m.useCaseKey])).toEqual([
      [
        'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/067b946cf014b7c697f3654f621d577a3e3afd1c/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        'ModelSpeedVeryFast',
        'Ui_ModelQualityBasic',
        'ModelUseCaseModestPcs',
      ],
      [
        'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        'ModelSpeedFast',
        'ModelQualityGood',
        'Ui_ModelUseCasePc8Gb',
      ],
      [
        'https://huggingface.co/ibm-granite/granite-4.0-micro-GGUF/resolve/ec48475f0c811d812fbfb61975717a9c36eeb652/granite-4.0-micro-Q4_K_M.gguf',
        'ModelSpeedFast',
        'ModelQualityGood',
        'Ui_ModelUseCasePc8Gb',
      ],
      [
        'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf',
        'ModelSpeedMedium',
        'ModelQualityExcellent',
        'Ui_ModelUseCasePc8Gb',
      ],
      [
        'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        'ModelSpeedFast',
        'ModelQualityVeryGood',
        'Ui_ModelUseCasePc12Gb',
      ],
      [
        'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf',
        'ModelSpeedSlowWithoutGpu',
        'ModelQualityExcellent',
        'ModelUseCasePc16GbOrGpu',
      ],
      [
        'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q4_K_M.gguf',
        'ModelSpeedSlowWithoutGpu',
        'ModelQualityExcellent',
        'ModelUseCaseGpuOnly',
      ],
      [
        'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf',
        'ModelSpeedFast',
        'ModelQualityVeryGood',
        'Ui_ModelUseCaseLegacy',
      ],
    ]);
  });

  it('formats the size with the 0.# pattern', () => {
    expect(SUMMARY_MODELS.map((m) => formatModelSize(m.fileSizeGb, 'en'))).toEqual([
      '0.8',
      '2',
      '2.1',
      '5',
      '2.5',
      '5',
      '7.1',
    ]);
    expect(formatModelSize(7.12, 'es')).toBe('7,1');
  });
});

describe('recommendedFor: the best model that runs well on this PC', () => {
  const hw = (
    totalRamGb: number,
    gpuVramGb: number | null = null,
    gpuName: string | null = gpuVramGb === null ? null : 'NVIDIA GeForce RTX 4060',
  ): HardwareProfile => ({ totalRamGb, gpuName, gpuVramGb });
  const pick = (hardware: HardwareProfile, options: RateOptions = {}) =>
    recommendedFor(hardware, options)?.displayName ?? null;

  it('4 GB: only the basic Llama 3.2 1B runs well', () => {
    expect(pick(hw(4))).toBe('Llama 3.2 1B Instruct');
  });

  it('6 GB: the 1B runs well, so it wins over better models that may be slow', () => {
    expect(pick(hw(6))).toBe('Llama 3.2 1B Instruct');
  });

  it('8 GB, no GPU: Gemma 4 E4B, the best of the 8 GB tier', () => {
    expect(pick(hw(8))).toBe('Gemma 4 E4B Instruct');
  });

  it('12 GB: Gemma 4 E4B still outranks Qwen3 4B', () => {
    expect(pick(hw(12))).toBe('Gemma 4 E4B Instruct');
  });

  it('16 GB: Gemma 4 12B', () => {
    expect(pick(hw(16))).toBe('Gemma 4 12B Instruct');
  });

  it('32 GB and an 8 GB GPU: Gemma 4 12B', () => {
    expect(pick(hw(32, 8))).toBe('Gemma 4 12B Instruct');
  });

  it('8 GB RAM and an 8 GB GPU: the GPU carries Gemma 4 12B', () => {
    expect(pick(hw(8, 8))).toBe('Gemma 4 12B Instruct');
  });

  it('the CPU runtime (gpuOffload false) cannot use that GPU: back to Gemma 4 E4B', () => {
    expect(pick(hw(8, 8), { gpuOffload: false })).toBe('Gemma 4 E4B Instruct');
  });

  it('with nothing that runs well, the best model that may be slow', () => {
    // 3 GB is 0.75 of the 1B minimum: MayBeSlow, nothing Recommended.
    expect(pick(hw(3))).toBe('Llama 3.2 1B Instruct');
    const heavy = SUMMARY_MODELS.filter((m) => m.minRamGb === 8);
    // 6 GB: the 8 GB tier may be slow, the best of it is Gemma 4 E4B.
    expect(recommendedFor(hw(6), {}, heavy)?.displayName).toBe('Gemma 4 E4B Instruct');
  });

  it('none when even the lightest model is too heavy', () => {
    expect(pick(hw(2))).toBeNull();
    expect(recommendedFor(hw(64), {}, [])).toBeNull();
  });

  it('never recommends a legacy model', () => {
    const onlyLegacy = [...LEGACY_SUMMARY_MODELS];
    expect(recommendedFor(hw(64), {}, onlyLegacy)).toBeNull();
  });
});

describe('fit rating', () => {
  const model: SummaryModelInfo = { ...SUMMARY_MODELS[3]!, minRamGb: 16 };
  const hw = (totalRamGb: number, gpuVramGb: number | null = null): HardwareProfile => ({
    totalRamGb,
    gpuName: gpuVramGb === null ? null : 'GPU',
    gpuVramGb,
  });

  it('recommended when RAM meets the minimum, exactly', () => {
    expect(rateFor(model, hw(16))).toBe('Recommended');
    expect(rateFor(model, hw(32))).toBe('Recommended');
  });

  it('may be slow from exactly 0.75 of the minimum', () => {
    expect(rateFor(model, hw(12))).toBe('MayBeSlow');
    expect(rateFor(model, hw(15.9))).toBe('MayBeSlow');
    expect(rateFor(model, hw(11.9))).toBe('NotRecommended');
  });

  it('not recommended far below', () => {
    expect(rateFor(model, hw(4))).toBe('NotRecommended');
  });

  it('a dedicated GPU with VRAM of at least half the minimum is recommended', () => {
    expect(rateFor(model, hw(8, 8))).toBe('Recommended');
    expect(rateFor(model, hw(8, 7.9))).toBe('NotRecommended');
  });

  it('no GPU, zero VRAM or null VRAM do not count as a dedicated GPU', () => {
    expect(rateFor(model, hw(8, 0))).toBe('NotRecommended');
    expect(rateFor(model, hw(8, null))).toBe('NotRecommended');
    expect(rateFor(model, hw(12, 0))).toBe('MayBeSlow');
  });
});

describe('fit rating by runtime backend (B17)', () => {
  const model: SummaryModelInfo = { ...SUMMARY_MODELS[3]!, minRamGb: 16 };
  const gpu: HardwareProfile = { totalRamGb: 8, gpuName: 'GPU', gpuVramGb: 8 };

  it('a CPU backend cannot use the VRAM, a GPU backend can', () => {
    expect(rateFor(model, gpu, { gpuOffload: false })).toBe('NotRecommended');
    expect(rateFor(model, gpu, { gpuOffload: true })).toBe('Recommended');
  });

  it('the default keeps the GPU rule', () => {
    expect(rateFor(model, gpu)).toBe('Recommended');
    expect(rateFor(model, gpu, {})).toBe('Recommended');
  });

  it('the RAM rules do not depend on the backend (boundaries 1.0, 0.75)', () => {
    const cpu = { gpuOffload: false };
    const ram = (gb: number): HardwareProfile => ({
      totalRamGb: gb,
      gpuName: null,
      gpuVramGb: null,
    });
    expect(rateFor(model, ram(16), cpu)).toBe('Recommended');
    expect(rateFor(model, ram(12), cpu)).toBe('MayBeSlow');
    expect(rateFor(model, ram(11.9), cpu)).toBe('NotRecommended');
  });
});

describe('note templates', () => {
  it('auto and unknown give no instructions', () => {
    for (const id of ['auto', 'custom', '', '  ', 'nope', null]) {
      expect(instructionsFor(id)).toBeNull();
    }
  });

  it('built-ins name the required shape, verbatim', () => {
    expect(instructionsFor('one-on-one')).toBe(
      'Shape the enhanced notes as a 1:1. Include decisions, feedback, and commitments that were actually stated. Omit a heading if that content is not in the sources.',
    );
    expect(instructionsFor('standup')).toBe(
      'Shape the enhanced notes as a standup. Include yesterday, today, and blockers that were actually stated. Omit a heading if that content is not in the sources.',
    );
    expect(instructionsFor('sales')).toBe(
      'Shape the enhanced notes as a sales call. Include pain, decision process, next step, and objections that were actually stated. Omit a heading if that content is not in the sources.',
    );
    expect(instructionsFor(' user-interview ')).toBe(
      'Shape the enhanced notes as a user interview. Include what they tried, quotes, and jobs-to-be-done. Quotes must be taken from the transcript or the raw notes. Do not invent quotes.',
    );
  });

  it('normalizes ids', () => {
    expect(normalizeTemplateId(null)).toBeNull();
    expect(normalizeTemplateId('  ')).toBeNull();
    expect(normalizeTemplateId(' AUTO ')).toBeNull();
    expect(normalizeTemplateId(' standup ')).toBe('standup');
    expect(normalizeTemplateId('custom')).toBe('custom');
  });

  it('options: the five built-ins in order, then a named custom template', () => {
    expect(NOTE_TEMPLATE_BUILT_INS.map((t) => t.id)).toEqual([
      'auto',
      'one-on-one',
      'standup',
      'sales',
      'user-interview',
    ]);
    expect(noteTemplateOptions(null).map((o) => o.id)).toHaveLength(5);
    expect(noteTemplateOptions({ name: '   ' }).map((o) => o.id)).toHaveLength(5);
    const withCustom = noteTemplateOptions({ name: '  Retro  ' });
    expect(withCustom.at(-1)).toEqual({ id: 'custom', labelKey: null, name: 'Retro' });
    expect(withCustom).toHaveLength(6);
  });
});

describe('B13: stored values that are not in the list', () => {
  it('the options keep the stored value so the control is never blank', () => {
    expect(optionsIncluding(CLAUDE_MODELS, 'gpt-9')).toEqual([...CLAUDE_MODELS, 'gpt-9']);
    expect(optionsIncluding(CLAUDE_MODELS, 'opus')).toEqual([...CLAUDE_MODELS]);
  });
});

describe('inference lists', () => {
  it('match the spec', () => {
    expect(CLAUDE_MODELS).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
    expect(CLAUDE_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(CODEX_MODELS).toEqual(['gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol']);
    expect(CODEX_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('cli executable names', () => {
  it('claude and codex only', () => {
    expect(cliExecutableName('ClaudeCode')).toBe('claude');
    expect(cliExecutableName('Codex')).toBe('codex');
    expect(() => cliExecutableName('Local')).toThrow(/Only ClaudeCode and Codex/);
    expect(() => cliExecutableName('Xai')).toThrow(RangeError);
  });
});
