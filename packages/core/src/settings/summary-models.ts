import { formatTemplate, type CatalogLocale } from '../i18n/format';

/** What the machine can run. From the hardware probe (spec contract `HardwareProfile`). */
export interface HardwareProfile {
  readonly totalRamGb: number;
  readonly gpuName: string | null;
  readonly gpuVramGb: number | null;
  /** False when the GPU query failed, so "no GPU" is a guess and must not be kept (B17). */
  readonly gpuReadComplete?: boolean;
}

export type FitRating = 'Recommended' | 'MayBeSlow' | 'NotRecommended';

export interface SummaryModelInfo {
  /** The persisted id and the file name on disk. */
  readonly fileName: string;
  readonly displayName: string;
  /** Who publishes the weights, shown next to the name. A brand, so it is never translated. */
  readonly vendor: string;
  /** Pinned to a repository commit (`/resolve/<sha>/`), so the bytes behind the hash cannot move. */
  readonly downloadUrl: string;
  readonly fileSizeGb: number;
  /** The exact size the host reports. "Downloaded" means the file has it (B18). */
  readonly sizeBytes: number;
  /**
   * Lowercase hex SHA-256 of the file, checked after the download. Every catalog entry pins one;
   * the store also accepts an entry without it (tests against a local server).
   */
  readonly sha256?: string;
  readonly minRamGb: number;
  /**
   * Summary quality order from public research, not our own eval: 1 is the best. It picks the
   * "Recommended for your PC" model among the ones that fit.
   */
  readonly rank: number;
  /** Extra `llama-server` flags this model needs, appended after the shared ones. */
  readonly serverArgs?: readonly string[];
  /**
   * A model that left the catalog. It is listed and usable only while its file is on disk, can be
   * deleted, and is never offered for download or recommended.
   */
  readonly legacy?: boolean;
  /** Catalog keys. The text is looked up when it is drawn, so a language change relabels them (B9). */
  readonly speedKey: string;
  readonly qualityKey: string;
  readonly useCaseKey: string;
}

const hf = (repo: string, commit: string, file: string): string =>
  `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

/**
 * Curated Q4_K_M GGUF models (spec 2.4), ascending by minimum RAM, lighter quality first within
 * the same RAM. Sizes and hashes verified against the Hugging Face tree API on 2026-11-06.
 */
export const SUMMARY_MODELS: readonly SummaryModelInfo[] = [
  {
    fileName: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    displayName: 'Llama 3.2 1B Instruct',
    vendor: 'Meta',
    downloadUrl: hf(
      'bartowski/Llama-3.2-1B-Instruct-GGUF',
      '067b946cf014b7c697f3654f621d577a3e3afd1c',
      'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    ),
    fileSizeGb: 0.81,
    sizeBytes: 807694464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    minRamGb: 4,
    rank: 7,
    speedKey: 'ModelSpeedVeryFast',
    qualityKey: 'Ui_ModelQualityBasic',
    useCaseKey: 'ModelUseCaseModestPcs',
  },
  {
    fileName: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    displayName: 'Llama 3.2 3B Instruct',
    vendor: 'Meta',
    downloadUrl: hf(
      'bartowski/Llama-3.2-3B-Instruct-GGUF',
      '5ab33fa94d1d04e903623ae72c95d1696f09f9e8',
      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    ),
    fileSizeGb: 2.02,
    sizeBytes: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    minRamGb: 8,
    rank: 6,
    speedKey: 'ModelSpeedFast',
    qualityKey: 'ModelQualityGood',
    useCaseKey: 'Ui_ModelUseCasePc8Gb',
  },
  {
    fileName: 'granite-4.0-micro-Q4_K_M.gguf',
    displayName: 'Granite 4.0 Micro',
    vendor: 'IBM',
    downloadUrl: hf(
      'ibm-granite/granite-4.0-micro-GGUF',
      'ec48475f0c811d812fbfb61975717a9c36eeb652',
      'granite-4.0-micro-Q4_K_M.gguf',
    ),
    fileSizeGb: 2.1,
    sizeBytes: 2099502528,
    sha256: '97c417dcc0534b0737c74016fb2af083cb17c3b51eaac621192d23961b7024eb',
    minRamGb: 8,
    rank: 5,
    speedKey: 'ModelSpeedFast',
    qualityKey: 'ModelQualityGood',
    useCaseKey: 'Ui_ModelUseCasePc8Gb',
  },
  {
    fileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
    displayName: 'Gemma 4 E4B Instruct',
    vendor: 'Google',
    downloadUrl: hf(
      'unsloth/gemma-4-E4B-it-GGUF',
      'bfc15c382204943c3a8fff0c750b94ae2364d7a3',
      'gemma-4-E4B-it-Q4_K_M.gguf',
    ),
    fileSizeGb: 4.98,
    sizeBytes: 4977171584,
    sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87',
    minRamGb: 8,
    rank: 3,
    speedKey: 'ModelSpeedMedium',
    qualityKey: 'ModelQualityExcellent',
    useCaseKey: 'Ui_ModelUseCasePc8Gb',
  },
  {
    fileName: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    displayName: 'Qwen3 4B Instruct 2507',
    vendor: 'Alibaba',
    downloadUrl: hf(
      'unsloth/Qwen3-4B-Instruct-2507-GGUF',
      'a06e946bb6b655725eafa393f4a9745d460374c9',
      'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    ),
    fileSizeGb: 2.5,
    sizeBytes: 2497281120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    minRamGb: 12,
    rank: 4,
    speedKey: 'ModelSpeedFast',
    qualityKey: 'ModelQualityVeryGood',
    useCaseKey: 'Ui_ModelUseCasePc12Gb',
  },
  {
    fileName: 'Qwen3-8B-Q4_K_M.gguf',
    displayName: 'Qwen3 8B',
    vendor: 'Alibaba',
    downloadUrl: hf(
      'Qwen/Qwen3-8B-GGUF',
      '7c41481f57cb95916b40956ab2f0b139b296d974',
      'Qwen3-8B-Q4_K_M.gguf',
    ),
    fileSizeGb: 5.03,
    sizeBytes: 5027783488,
    sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
    minRamGb: 16,
    rank: 2,
    // A hybrid thinking model: summaries need the answer only (llama.cpp b12063 `--reasoning`).
    serverArgs: ['--reasoning', 'off'],
    speedKey: 'ModelSpeedSlowWithoutGpu',
    qualityKey: 'ModelQualityExcellent',
    useCaseKey: 'ModelUseCasePc16GbOrGpu',
  },
  {
    fileName: 'gemma-4-12b-it-Q4_K_M.gguf',
    displayName: 'Gemma 4 12B Instruct',
    vendor: 'Google',
    downloadUrl: hf(
      'unsloth/gemma-4-12b-it-GGUF',
      'fc034cfff751157913579611efad8462ac1be606',
      'gemma-4-12b-it-Q4_K_M.gguf',
    ),
    fileSizeGb: 7.12,
    sizeBytes: 7121861440,
    sha256: '0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42',
    minRamGb: 16,
    rank: 1,
    speedKey: 'ModelSpeedSlowWithoutGpu',
    qualityKey: 'ModelQualityExcellent',
    useCaseKey: 'ModelUseCaseGpuOnly',
  },
];

/**
 * Models that left the catalog (2026-11-06). Users who downloaded one keep it: it is listed while
 * its file is there, stays selectable and deletable, and is never downloaded again.
 */
export const LEGACY_SUMMARY_MODELS: readonly SummaryModelInfo[] = [
  {
    fileName: 'gemma-4-E2B-it-Q4_K_M.gguf',
    displayName: 'Gemma 4 E2B Instruct',
    vendor: 'Google',
    downloadUrl: hf(
      'unsloth/gemma-4-E2B-it-GGUF',
      '0314792d7f1f7e229411f620751375812bb9faf2',
      'gemma-4-E2B-it-Q4_K_M.gguf',
    ),
    fileSizeGb: 3.11,
    sizeBytes: 3106738272,
    sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
    minRamGb: 6,
    // Between Gemma 4 E4B (3) and Qwen3 4B (4); only orders it, legacy is never recommended.
    rank: 3.5,
    legacy: true,
    speedKey: 'ModelSpeedFast',
    qualityKey: 'ModelQualityVeryGood',
    useCaseKey: 'Ui_ModelUseCaseLegacy',
  },
];

/** Every model the app knows by file name: the catalog and the legacy entries. */
const KNOWN_MODELS: readonly SummaryModelInfo[] = [...SUMMARY_MODELS, ...LEGACY_SUMMARY_MODELS];

export const findSummaryModel = (fileName: string | null | undefined): SummaryModelInfo | null =>
  KNOWN_MODELS.find((model) => model.fileName === fileName) ?? null;

/** The extra `llama-server` flags for a model file, none for an unknown one. */
export const serverArgsFor = (fileName: string | null | undefined): readonly string[] =>
  findSummaryModel(fileName)?.serverArgs ?? [];

const hasDedicatedGpu = (hardware: HardwareProfile): boolean =>
  hardware.gpuVramGb !== null && hardware.gpuVramGb > 0;

export interface RateOptions {
  /**
   * Whether the llama runtime in use can offload to the GPU. When false (the CPU build) the VRAM
   * cannot stand in for RAM (B17). Defaults to true, the behavior before the runtime choice existed.
   */
  readonly gpuOffload?: boolean;
}

/** Spec 2.4: enough RAM, or a usable GPU holding half of it; else slow from 75 % of the RAM. */
export function rateFor(
  model: SummaryModelInfo,
  hardware: HardwareProfile,
  options: RateOptions = {},
): FitRating {
  const gpuCounts = (options.gpuOffload ?? true) && hasDedicatedGpu(hardware);
  if (
    hardware.totalRamGb >= model.minRamGb ||
    (gpuCounts && (hardware.gpuVramGb ?? 0) >= model.minRamGb / 2)
  ) {
    return 'Recommended';
  }
  if (hardware.totalRamGb >= model.minRamGb * 0.75) return 'MayBeSlow';
  return 'NotRecommended';
}

/**
 * "Recommended for your PC": the best-ranked model that runs well here; if none does, the best one
 * that may be slow; else null. Legacy models are never picked. Uses the same rule as `rateFor`.
 */
export function recommendedFor(
  hardware: HardwareProfile,
  options: RateOptions = {},
  models: readonly SummaryModelInfo[] = SUMMARY_MODELS,
): SummaryModelInfo | null {
  const ranked = models.filter((m) => m.legacy !== true).sort((a, b) => a.rank - b.rank);
  const fitting = (fit: FitRating) => ranked.find((m) => rateFor(m, hardware, options) === fit);
  return fitting('Recommended') ?? fitting('MayBeSlow') ?? null;
}

/**
 * The rating is hardware fit, not a pick: every model can fit a large PC. The labels say so in
 * plain words (settings polish 2026-11-05); the WinUI `Fit_` strings read as recommendations.
 */
export const FIT_LABEL_KEYS: Readonly<Record<FitRating, string>> = {
  Recommended: 'Ui_FitRunsWell',
  MayBeSlow: 'Ui_FitMayBeSlow',
  NotRecommended: 'Ui_FitTooHeavy',
};

/** The size as the .NET `0.#` pattern writes it in the locale: 0.81 gives 0.8, 4.98 gives 5. */
export const formatModelSize = (sizeGb: number, locale: CatalogLocale): string =>
  formatTemplate('{0:0.#}', [sizeGb], locale);
