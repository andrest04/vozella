import { describe, expect, it } from 'vitest';
import type { AsrResult } from './asr-types';
import { AsrBackendStatus } from './backend-status';
import { LiveTranscriptionService } from './live-service';
import { MIC_ACTIVITY_FRAME_MS, type SourceLevels } from './mic-activity';
import { NemoSpeechRecognizerFactory } from './recognizer-factory';
import { FakeAsrEngine, FakeModelStore, FakeRuntimeStore } from './test-kit';

const spoken: AsrResult = {
  isFinal: true,
  transcript: 'hola',
  audioProcessedSeconds: 1,
  words: [{ startMs: 0, endMs: 1000, speakerTag: 0, text: 'hola' }],
};

/** 1 s of audio as one frame. */
const second = new Float32Array(16_000);
const levelsOf = (microphone: number, output: number): SourceLevels[] =>
  Array.from({ length: 1000 / MIC_ACTIVITY_FRAME_MS }, () => ({ microphone, output }));
const micLevels = levelsOf(0.1, 0);
const echoLevels = levelsOf(0.02, 0.1);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function startLive(speakerDiarization: boolean): Promise<LiveTranscriptionService> {
  const engine = new FakeAsrEngine();
  const models = new FakeModelStore();
  const runtimes = new FakeRuntimeStore();
  models.model = true;
  models.diarization = true;
  runtimes.ready.add('cpu');
  const factory = new NemoSpeechRecognizerFactory({
    engine,
    models,
    runtimes,
    hardware: () => Promise.resolve({ gpuName: null }),
    status: new AsrBackendStatus(),
  });
  engine.script = { afterPush: [[spoken]] };
  const live = new LiveTranscriptionService({ factory });
  await live.start({ language: 'es', recordedAtMs: null, speakerDiarization });
  return live;
}

describe('LiveTranscriptionService.micDominantShare', () => {
  it('is null when no session ever ran', () => {
    const live = new LiveTranscriptionService({
      factory: { create: () => Promise.reject(new Error('unused')) },
    });
    expect(live.micDominantShare(0, 1000)).toBeNull();
  });

  for (const labels of [false, true]) {
    describe(`with speaker labels ${labels ? 'on' : 'off'}`, () => {
      it('is near 1 over a span the microphone dominated', async () => {
        const live = await startLive(labels);
        live.pushFrame(second, 16_000, micLevels);
        await flush();
        expect(live.micDominantShare(0, 1000)).toBeCloseTo(1, 5);
        await live.stop();
      });

      it('is near 0 for echo: output louder than the microphone', async () => {
        const live = await startLive(labels);
        live.pushFrame(second, 16_000, echoLevels);
        await flush();
        expect(live.micDominantShare(0, 1000)).toBeCloseTo(0, 5);
        await live.stop();
      });

      it('is null while no frame has carried levels', async () => {
        const live = await startLive(labels);
        expect(live.micDominantShare(0, 1000)).toBeNull();
        live.pushFrame(second, 16_000);
        await flush();
        expect(live.micDominantShare(0, 1000)).toBeNull();
        await live.stop();
      });

      it('is null once the session stopped', async () => {
        const live = await startLive(labels);
        live.pushFrame(second, 16_000, micLevels);
        await flush();
        await live.stop();
        expect(live.micDominantShare(0, 1000)).toBeNull();
      });
    });
  }
});
