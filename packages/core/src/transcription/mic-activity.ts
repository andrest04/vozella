/**
 * When the local user speaks into the microphone (spec 3.6, "You" speaker label).
 *
 * The recording is one mixed stream, so the transcript cannot tell the microphone from the
 * meeting audio by itself. The capture side measures both sources before they are mixed, in
 * {@link MIC_ACTIVITY_FRAME_MS} frames, and {@link MicActivityRecorder} turns those levels into
 * ranges where the microphone clearly dominates. The live pass reads them as frames arrive; the
 * offline pass reads them from a small sidecar next to the WAV ({@link micActivityPathFor}).
 */

/** Length of one measured frame. A 200 ms pump chunk is four frames. */
export const MIC_ACTIVITY_FRAME_MS = 50;
/** Microphone RMS (0..1) below this is room noise, never speech (about -40 dBFS). */
export const MIC_NOISE_FLOOR_RMS = 0.01;
/**
 * The microphone must be at least this many times louder (RMS) than the output, about 6 dB.
 * Speaker echo and headset bleed reach the microphone far weaker than the digital output.
 */
export const MIC_DOMINANCE_RATIO = 2;
/** Microphone frames in a row that open a range (100 ms), so a cough or click does not. */
export const MIC_ENTER_FRAMES = 2;
/** Non-microphone frames in a row that close a range (300 ms): pauses between words stay in. */
export const MIC_HANG_FRAMES = 6;
/** Output-dominant frames in a row that close a range at once: a remote reply cuts the hang. */
export const MIC_OUTPUT_EXIT_FRAMES = 2;

/** RMS (0..1) of each source over one frame, measured before mixing. */
export interface SourceLevels {
  readonly microphone: number;
  readonly output: number;
}

/** A stretch of the recording, in milliseconds from its start, where the local user spoke. */
export interface MicActivityRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** What the transcript asks: how much of a word's span the microphone dominated (0..1). */
export interface MicActivity {
  dominantShare(startMs: number, endMs: number): number;
}

export type FrameSource = 'microphone' | 'output' | 'quiet';

const level = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Which source a frame belongs to. Neither clearly dominant (double talk, bleed) is quiet. */
export function classifyFrame(levels: SourceLevels): FrameSource {
  const microphone = level(levels.microphone);
  const output = level(levels.output);
  if (microphone >= MIC_NOISE_FLOOR_RMS && microphone >= output * MIC_DOMINANCE_RATIO) {
    return 'microphone';
  }
  if (output >= MIC_NOISE_FLOOR_RMS && output > microphone) return 'output';
  return 'quiet';
}

/** Microphone-dominant ranges from frame levels, with hysteresis (see the thresholds above). */
export class MicActivityRecorder implements MicActivity {
  private readonly closed: MicActivityRange[] = [];
  private frames = 0;
  /** Microphone frames in a row while no range is open. */
  private candidate = 0;
  private open: { startMs: number; endMs: number } | null = null;
  private nonMicrophone = 0;
  private outputRun = 0;

  constructor(private readonly frameMs: number = MIC_ACTIVITY_FRAME_MS) {}

  /** Audio measured so far. */
  get elapsedMs(): number {
    return this.frames * this.frameMs;
  }

  /** Closed ranges plus the open one, in order. */
  get ranges(): readonly MicActivityRange[] {
    return this.open === null ? [...this.closed] : [...this.closed, { ...this.open }];
  }

  push(levels: SourceLevels): void {
    const startMs = this.frames * this.frameMs;
    const endMs = startMs + this.frameMs;
    this.frames += 1;
    const source = classifyFrame(levels);
    if (this.open === null) {
      this.candidate = source === 'microphone' ? this.candidate + 1 : 0;
      if (this.candidate >= MIC_ENTER_FRAMES) {
        // The range starts at the first frame of the run that confirmed it.
        this.open = { startMs: endMs - this.candidate * this.frameMs, endMs };
        this.candidate = 0;
        this.nonMicrophone = 0;
        this.outputRun = 0;
      }
      return;
    }
    if (source === 'microphone') {
      this.open.endMs = endMs;
      this.nonMicrophone = 0;
      this.outputRun = 0;
      return;
    }
    this.nonMicrophone += 1;
    this.outputRun = source === 'output' ? this.outputRun + 1 : 0;
    if (this.nonMicrophone >= MIC_HANG_FRAMES || this.outputRun >= MIC_OUTPUT_EXIT_FRAMES) {
      // The range ends at its last microphone frame: the hang bridges gaps, it never extends.
      this.closed.push(this.open);
      this.open = null;
    }
  }

  dominantShare(startMs: number, endMs: number): number {
    return shareOf(this.ranges, startMs, endMs);
  }
}

/** Ranges read back from a sidecar. */
export class MicActivityTimeline implements MicActivity {
  constructor(readonly ranges: readonly MicActivityRange[]) {}

  dominantShare(startMs: number, endMs: number): number {
    return shareOf(this.ranges, startMs, endMs);
  }
}

/** Ranges must be sorted and disjoint. A zero-length span is the point it sits on. */
function shareOf(ranges: readonly MicActivityRange[], startMs: number, endMs: number): number {
  if (ranges.length === 0) return 0;
  const from = firstEndingAfter(ranges, startMs);
  if (endMs <= startMs) {
    const range = ranges[from];
    return range !== undefined && range.startMs <= startMs ? 1 : 0;
  }
  let covered = 0;
  for (let i = from; i < ranges.length; i += 1) {
    const range = ranges[i];
    if (range === undefined || range.startMs >= endMs) break;
    covered += Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs);
  }
  return Math.max(0, covered) / (endMs - startMs);
}

/** Index of the first range that ends after `ms` (binary search). */
function firstEndingAfter(ranges: readonly MicActivityRange[], ms: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((ranges[mid]?.endMs ?? Infinity) <= ms) low = mid + 1;
    else high = mid;
  }
  return low;
}

function rms(samples: Float32Array | null, from: number, to: number): number {
  if (samples === null) return 0;
  const end = Math.min(to, samples.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / (end - from));
}

/**
 * Levels per {@link MIC_ACTIVITY_FRAME_MS} frame of one chunk of each source, before mixing.
 * A missing source (no microphone) or a short one reads as silence.
 */
export function frameLevels(
  microphone: Float32Array | null,
  output: Float32Array | null,
  sampleRate: number,
): SourceLevels[] {
  const frameSamples = Math.max(1, Math.round((MIC_ACTIVITY_FRAME_MS * sampleRate) / 1000));
  const length = Math.max(microphone?.length ?? 0, output?.length ?? 0);
  const levels: SourceLevels[] = [];
  for (let from = 0; from < length; from += frameSamples) {
    const to = from + frameSamples;
    levels.push({ microphone: rms(microphone, from, to), output: rms(output, from, to) });
  }
  return levels;
}

const SIDECAR_VERSION = 1;

/** The sidecar of a recording: `<name>.mic.json` next to `<name>.wav`. */
export function micActivityPathFor(audioPath: string): string {
  return audioPath.replace(/\.[^./\\]*$/, '') + '.mic.json';
}

export function serializeMicActivity(ranges: readonly MicActivityRange[]): string {
  return JSON.stringify({
    version: SIDECAR_VERSION,
    ranges: ranges.map((range) => [range.startMs, range.endMs]),
  });
}

/** The ranges, or null when the text is not a valid sidecar (then the recording is legacy). */
export function parseMicActivity(text: string): MicActivityRange[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { version, ranges } = parsed as { version?: unknown; ranges?: unknown };
  if (version !== SIDECAR_VERSION || !Array.isArray(ranges)) return null;
  const result: MicActivityRange[] = [];
  let previousEnd = 0;
  for (const pair of ranges as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [startMs, endMs] = pair as unknown[];
    if (typeof startMs !== 'number' || typeof endMs !== 'number') return null;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (startMs < previousEnd || endMs <= startMs) return null;
    result.push({ startMs, endMs });
    previousEnd = endMs;
  }
  return result;
}
