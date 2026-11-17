import type { CancelSignal } from '../cancel';
import type { HardwareProfile } from '../settings/summary-models';
import type {
  AsrBackend,
  AsrEngine,
  AsrLatencyProfile,
  AsrRecognizer,
  SortformerGeometry,
} from './asr-types';
import { STREAMING_GEOMETRY } from './asr-types';
import type { AsrBackendStatus, DiarizationState } from './backend-status';
import type { EngineModelStore, RuntimeStore } from './ports';

const NVIDIA_NAMES = ['nvidia', 'geforce', 'quadro', 'tesla'];

/** True when the GPU name looks like an NVIDIA card (the only one CUDA can use). */
export function hasNvidiaGpu(hardware: Pick<HardwareProfile, 'gpuName'>): boolean {
  const name = hardware.gpuName;
  if (name === null || name.trim() === '') return false;
  const lower = name.toLowerCase();
  return NVIDIA_NAMES.some((part) => lower.includes(part));
}

export const selectBackend = (hardware: Pick<HardwareProfile, 'gpuName'>): AsrBackend =>
  hasNvidiaGpu(hardware) ? 'cuda' : 'cpu';

export interface CreateRecognizerOptions {
  readonly enableDiarization?: boolean;
  readonly geometry?: SortformerGeometry;
  readonly latency?: AsrLatencyProfile;
  /**
   * Stops the pass. The cloud engine aborts its request in flight with it; the local engine does
   * not use it (its callers check the signal between frames, as before).
   */
  readonly cancel?: CancelSignal;
}

/** What a pass needs from whichever engine recognizes it. */
export interface SessionRecognizer {
  readonly recognizer: AsrRecognizer;
  /** True when speaker labels will be produced: the recognizer was created with the speaker model. */
  readonly diarization: boolean;
}

/**
 * Where the live and the offline pass get their recognizer. The local factory is one; the cloud
 * engine provider is another. A pass asks once, when it starts.
 */
export interface RecognizerSource {
  create(options?: CreateRecognizerOptions): Promise<SessionRecognizer>;
}

export interface CreatedRecognizer extends SessionRecognizer {
  readonly backend: AsrBackend;
  readonly fallbackReason: string | null;
}

export interface RecognizerFactoryDeps {
  readonly engine: AsrEngine;
  readonly models: EngineModelStore;
  readonly runtimes: RuntimeStore;
  readonly hardware: () => Promise<Pick<HardwareProfile, 'gpuName'>>;
  readonly status?: AsrBackendStatus;
}

/** Picks CUDA or CPU and builds the recognizer. */
export class NemoSpeechRecognizerFactory implements RecognizerSource {
  constructor(private readonly deps: RecognizerFactoryDeps) {}

  async create(options: CreateRecognizerOptions = {}): Promise<CreatedRecognizer> {
    const { models, runtimes, engine } = this.deps;
    if (!models.isModelDownloaded()) {
      throw new Error('The Nemotron ASR model is not installed.');
    }
    const modelPath = models.modelPath();
    const wantsDiarization = options.enableDiarization === true;
    const diarModelPath =
      wantsDiarization && models.isDiarizationModelDownloaded()
        ? models.diarizationModelPath()
        : null;
    const geometry = options.geometry ?? STREAMING_GEOMETRY;
    const latency = options.latency ?? 'live';
    const settings = (
      binDirectory: string,
      gpu: number,
    ): Parameters<AsrEngine['createRecognizer']>[0] => ({
      modelPath,
      binDirectory,
      gpu,
      diarizationModelPath: diarModelPath,
      geometry,
      latency,
    });

    const preferred = selectBackend(await this.deps.hardware());
    let fallbackReason: string | null = null;
    if (preferred === 'cuda' && runtimes.isReady('cuda')) {
      try {
        const recognizer = await engine.createRecognizer(
          settings(runtimes.binDirectory('cuda'), 0),
        );
        return this.finish(recognizer, 'cuda', null, wantsDiarization, diarModelPath);
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error);
      }
    }
    if (!runtimes.isReady('cpu')) {
      throw new Error('The Nemotron ASR CPU runtime is not installed.');
    }
    const recognizer = await engine.createRecognizer(settings(runtimes.binDirectory('cpu'), -1));
    return this.finish(recognizer, 'cpu', fallbackReason, wantsDiarization, diarModelPath);
  }

  private finish(
    recognizer: AsrRecognizer,
    backend: AsrBackend,
    fallbackReason: string | null,
    wantsDiarization: boolean,
    diarModelPath: string | null,
  ): CreatedRecognizer {
    const diarization: DiarizationState = !wantsDiarization
      ? 'off'
      : diarModelPath === null
        ? 'model-missing'
        : 'on';
    this.deps.status?.report({ backend, fallbackReason, diarization });
    return { recognizer, backend, fallbackReason, diarization: diarModelPath !== null };
  }
}
