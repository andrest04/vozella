import { describe, expect, it } from 'vitest';
import type { AsrResult } from './asr-types';
import { AsrBackendStatus } from './backend-status';
import { LiveTranscriptionService } from './live-service';
import { MIC_ACTIVITY_FRAME_MS, MicActivityTimeline, type SourceLevels } from './mic-activity';
import { TranscriptionService } from './offline-service';
import { NemoSpeechRecognizerFactory } from './recognizer-factory';
import { FakeAsrEngine, FakeAudioReader, FakeModelStore, FakeRuntimeStore } from './test-kit';

/** One word from 0 to 1 s, untagged by Sortformer. */
const spoken: AsrResult = {
  isFinal: true,
  transcript: 'hola',
  audioProcessedSeconds: 1,
  words: [{ startMs: 0, endMs: 1000, speakerTag: 0, text: 'hola' }],
};
const YOU_LINE = '[00:00.00-00:01.00] [ You ] hola';
const PLAIN_LINE = '[00:00.00-00:01.00] hola';

function setup(speakerModel: boolean) {
  const engine = new FakeAsrEngine();
  const models = new FakeModelStore();
  const runtimes = new FakeRuntimeStore();
  models.model = true;
  models.diarization = speakerModel;
  runtimes.ready.add('cpu');
  const factory = new NemoSpeechRecognizerFactory({
    engine,
    models,
    runtimes,
    hardware: () => Promise.resolve({ gpuName: null }),
    status: new AsrBackendStatus(),
  });
  engine.script = { afterPush: [[spoken]] };
  return { engine, factory };
}

describe('offline pass with microphone activity', () => {
  const micActivity = new MicActivityTimeline([{ startMs: 0, endMs: 1000 }]);
  const transcribe = async (speakerModel: boolean, speakerDiarization: boolean, withMic = true) => {
    const { factory } = setup(speakerModel);
    const audio = new FakeAudioReader(new Float32Array(1600), 16_000, 1);
    const asked: string[] = [];
    const reader = {
      read: (audioPath: string) => {
        asked.push(audioPath);
        return withMic ? micActivity : null;
      },
    };
    const text = await new TranscriptionService({ factory, audio, micActivity: reader }).transcribe(
      { audioPath: 'a.wav', language: 'es', recordedAtMs: null, speakerDiarization },
    );
    return { text, asked };
  };

  it('labels the microphone words as you when speaker labels run', async () => {
    expect(await transcribe(true, true)).toEqual({ text: YOU_LINE, asked: ['a.wav'] });
  });

  it('adds no label and reads no sidecar when speaker labels are off', async () => {
    expect(await transcribe(true, false)).toEqual({ text: PLAIN_LINE, asked: [] });
  });

  it('adds no label when the speaker model is missing (labels do not run)', async () => {
    expect(await transcribe(false, true)).toEqual({ text: PLAIN_LINE, asked: [] });
  });

  it('keeps today’s output for a recording without activity (legacy)', async () => {
    expect((await transcribe(true, true, false)).text).toBe(PLAIN_LINE);
  });

  it('keeps today’s output when no reader is wired', async () => {
    const { factory } = setup(true);
    const audio = new FakeAudioReader(new Float32Array(1600), 16_000, 1);
    const text = await new TranscriptionService({ factory, audio }).transcribe({
      audioPath: 'a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: true,
    });
    expect(text).toBe(PLAIN_LINE);
  });
});

describe('live pass with microphone levels', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  /** 1 s of audio as one frame, with the microphone dominant all along. */
  const second = new Float32Array(16_000);
  const micLevels: SourceLevels[] = Array.from({ length: 1000 / MIC_ACTIVITY_FRAME_MS }, () => ({
    microphone: 0.1,
    output: 0,
  }));

  const run = async (
    speakerModel: boolean,
    speakerDiarization: boolean,
    levels?: readonly SourceLevels[],
  ): Promise<string> => {
    const { factory } = setup(speakerModel);
    const live = new LiveTranscriptionService({ factory });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization });
    live.pushFrame(second, 16_000, levels);
    await flush();
    return live.stop();
  };

  it('labels the microphone words as you from the levels of the frames it fed', async () => {
    expect(await run(true, true, micLevels)).toBe(YOU_LINE);
  });

  it('adds no label when speaker labels are off', async () => {
    expect(await run(true, false, micLevels)).toBe(PLAIN_LINE);
  });

  it('keeps today’s output when frames carry no levels', async () => {
    expect(await run(true, true)).toBe(PLAIN_LINE);
  });

  it('rejects echo: output louder than the microphone is not you', async () => {
    const echo = micLevels.map(() => ({ microphone: 0.02, output: 0.1 }));
    expect(await run(true, true, echo)).toBe(PLAIN_LINE);
  });
});
