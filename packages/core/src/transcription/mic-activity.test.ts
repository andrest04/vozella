import { describe, expect, it } from 'vitest';
import {
  MIC_ACTIVITY_FRAME_MS,
  MIC_DOMINANCE_RATIO,
  MIC_ENTER_FRAMES,
  MIC_HANG_FRAMES,
  MIC_NOISE_FLOOR_RMS,
  MIC_OUTPUT_EXIT_FRAMES,
  MicActivityRecorder,
  MicActivityTimeline,
  classifyFrame,
  frameLevels,
  micActivityPathFor,
  parseMicActivity,
  serializeMicActivity,
  type SourceLevels,
} from './mic-activity';

const F = MIC_ACTIVITY_FRAME_MS;
const VOICE = 0.1;
/** Speech on the microphone with nothing on the output. */
const MIC: SourceLevels = { microphone: VOICE, output: 0 };
/** Remote speech on the output, heard faintly by the microphone through the speakers. */
const ECHO: SourceLevels = { microphone: VOICE / 4, output: VOICE };
const QUIET: SourceLevels = { microphone: 0.001, output: 0.001 };

const record = (...frames: SourceLevels[]): MicActivityRecorder => {
  const recorder = new MicActivityRecorder();
  for (const frame of frames) recorder.push(frame);
  return recorder;
};
const times = (count: number, frame: SourceLevels): SourceLevels[] =>
  Array.from({ length: count }, () => frame);

describe('classifyFrame', () => {
  it('documents its thresholds', () => {
    expect(MIC_ACTIVITY_FRAME_MS).toBe(50);
    expect(MIC_NOISE_FLOOR_RMS).toBe(0.01);
    expect(MIC_DOMINANCE_RATIO).toBe(2);
    expect(MIC_ENTER_FRAMES).toBe(2);
    expect(MIC_HANG_FRAMES).toBe(6);
    expect(MIC_OUTPUT_EXIT_FRAMES).toBe(2);
  });

  it('is microphone when the mic is above the floor and clearly louder than the output', () => {
    expect(classifyFrame(MIC)).toBe('microphone');
    expect(classifyFrame({ microphone: 0.1, output: 0.05 })).toBe('microphone');
  });

  it('rejects echo and bleed: the mic is not clearly louder than the output', () => {
    expect(classifyFrame(ECHO)).toBe('output');
    expect(classifyFrame({ microphone: 0.1, output: 0.06 })).toBe('quiet');
  });

  it('is quiet below the noise floor, even with a silent output', () => {
    expect(classifyFrame({ microphone: 0.009, output: 0 })).toBe('quiet');
    expect(classifyFrame(QUIET)).toBe('quiet');
  });

  it('treats a missing level (NaN) as silence', () => {
    expect(classifyFrame({ microphone: Number.NaN, output: 0 })).toBe('quiet');
  });
});

describe('MicActivityRecorder', () => {
  it('needs a few microphone frames in a row before it opens a range', () => {
    expect(record(MIC).ranges).toEqual([]);
    expect(record(MIC, QUIET, MIC).ranges).toEqual([]);
    expect(record(MIC, MIC).ranges).toEqual([{ startMs: 0, endMs: 2 * F }]);
  });

  it('starts the range at the first confirming frame, not when it was confirmed', () => {
    expect(record(QUIET, QUIET, MIC, MIC, MIC).ranges).toEqual([{ startMs: 2 * F, endMs: 5 * F }]);
  });

  it('bridges short gaps inside the local speech (hysteresis)', () => {
    const recorder = record(MIC, MIC, ...times(MIC_HANG_FRAMES - 1, QUIET), MIC);
    expect(recorder.ranges).toEqual([{ startMs: 0, endMs: (MIC_HANG_FRAMES + 2) * F }]);
  });

  it('closes after a long quiet stretch, ending at the last microphone frame', () => {
    const recorder = record(MIC, MIC, ...times(MIC_HANG_FRAMES, QUIET), MIC, MIC);
    expect(recorder.ranges).toEqual([
      { startMs: 0, endMs: 2 * F },
      { startMs: (MIC_HANG_FRAMES + 2) * F, endMs: (MIC_HANG_FRAMES + 4) * F },
    ]);
  });

  it('closes early when the output takes over, so a remote reply is not labelled as you', () => {
    const recorder = record(MIC, MIC, MIC, ECHO, ECHO, MIC, MIC);
    expect(recorder.ranges).toEqual([
      { startMs: 0, endMs: 3 * F },
      { startMs: 5 * F, endMs: 7 * F },
    ]);
  });

  it('ignores a single output blip inside the local speech', () => {
    expect(record(MIC, MIC, ECHO, MIC).ranges).toEqual([{ startMs: 0, endMs: 4 * F }]);
  });

  it('never opens a range on echo alone (speakers, no local speech)', () => {
    expect(record(...times(40, ECHO)).ranges).toEqual([]);
  });

  it('never opens a range with a muted or absent microphone', () => {
    const muted = { microphone: 0, output: 0 };
    expect(record(...times(40, muted)).ranges).toEqual([]);
  });

  it('counts elapsed audio frame by frame', () => {
    expect(record(QUIET, MIC, MIC).elapsedMs).toBe(3 * F);
  });

  it('answers the share of a span covered by microphone speech, open range included', () => {
    const recorder = record(MIC, MIC, MIC, MIC);
    expect(recorder.dominantShare(0, 4 * F)).toBe(1);
    expect(recorder.dominantShare(2 * F, 6 * F)).toBe(0.5);
  });
});

describe('MicActivityTimeline', () => {
  const timeline = new MicActivityTimeline([
    { startMs: 1000, endMs: 2000 },
    { startMs: 3000, endMs: 4000 },
  ]);

  it('is 1 inside a range and 0 outside every range', () => {
    expect(timeline.dominantShare(1200, 1800)).toBe(1);
    expect(timeline.dominantShare(2100, 2900)).toBe(0);
    expect(timeline.dominantShare(5000, 6000)).toBe(0);
  });

  it('measures partial overlaps across several ranges', () => {
    expect(timeline.dominantShare(1500, 2500)).toBe(0.5);
    expect(timeline.dominantShare(1000, 4000)).toBeCloseTo(2 / 3);
  });

  it('reads a zero-length span as the point it sits on', () => {
    expect(timeline.dominantShare(1500, 1500)).toBe(1);
    expect(timeline.dominantShare(2500, 2500)).toBe(0);
  });

  it('is empty with no ranges', () => {
    expect(new MicActivityTimeline([]).dominantShare(0, 1000)).toBe(0);
  });
});

describe('frameLevels', () => {
  it('measures the RMS of each source per frame', () => {
    const samples = (MIC_ACTIVITY_FRAME_MS * 16_000) / 1000;
    const mic = new Float32Array(samples * 2).fill(0.5);
    const output = new Float32Array(samples * 2);
    output.fill(0.25, samples);
    expect(frameLevels(mic, output, 16_000)).toEqual([
      { microphone: 0.5, output: 0 },
      { microphone: 0.5, output: 0.25 },
    ]);
  });

  it('treats a shorter or missing source as silence', () => {
    const samples = (MIC_ACTIVITY_FRAME_MS * 16_000) / 1000;
    const mic = new Float32Array(samples).fill(0.5);
    expect(frameLevels(mic, null, 16_000)).toEqual([{ microphone: 0.5, output: 0 }]);
    expect(frameLevels(null, mic, 16_000)).toEqual([{ microphone: 0, output: 0.5 }]);
  });
});

describe('mic activity sidecar', () => {
  const ranges = [
    { startMs: 0, endMs: 1200 },
    { startMs: 3400, endMs: 5000 },
  ];

  it('round-trips the ranges', () => {
    expect(parseMicActivity(serializeMicActivity(ranges))).toEqual(ranges);
    expect(parseMicActivity(serializeMicActivity([]))).toEqual([]);
  });

  it('names the sidecar after the recording', () => {
    expect(micActivityPathFor('C:\\m\\2026-11-07 Standup.wav')).toBe(
      'C:\\m\\2026-11-07 Standup.mic.json',
    );
    expect(micActivityPathFor('/m/a.b/take')).toBe('/m/a.b/take.mic.json');
  });

  it.each([
    ['not json', '{'],
    ['an unknown version', JSON.stringify({ version: 2, ranges: [] })],
    ['no ranges', JSON.stringify({ version: 1 })],
    ['a malformed pair', JSON.stringify({ version: 1, ranges: [[1]] })],
    ['an empty range', JSON.stringify({ version: 1, ranges: [[5, 5]] })],
    ['a negative start', JSON.stringify({ version: 1, ranges: [[-1, 5]] })],
    [
      'overlapping ranges',
      JSON.stringify({
        version: 1,
        ranges: [
          [0, 10],
          [5, 20],
        ],
      }),
    ],
    ['a non-number', JSON.stringify({ version: 1, ranges: [['0', 10]] })],
  ])('rejects %s (the recording is then read as a legacy one)', (_name, text) => {
    expect(parseMicActivity(text)).toBeNull();
  });
});
