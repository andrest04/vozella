/** Level helpers. Pure math, no I/O. */

const FLOOR_DECIBELS = -60;
const MIN_AMPLITUDE = 1e-6;

/** Maps a linear amplitude (RMS or peak) to a 0..1 meter position on a dB scale. */
export function toMeterValue(amplitude: number): number {
  if (Number.isNaN(amplitude)) return 0;
  const db = 20 * Math.log10(Math.max(amplitude, MIN_AMPLITUDE));
  const value = (db - FLOOR_DECIBELS) / -FLOOR_DECIBELS;
  return Math.min(1, Math.max(0, value));
}

/** The 0..100 bar position both the recording bar and the app cards use. */
export function toMeterPercent(amplitude: number): number {
  return toMeterValue(amplitude) * 100;
}

export type SampleFormat = 'float32' | 'int16' | 'int32' | 'int24';

/**
 * RMS over all interleaved samples of a raw buffer, clamped to [0, 1].
 * Non-finite floats are skipped. Depths other than float32, int16 and int32 read as zero.
 */
export function computeBufferRms(bytes: Uint8Array, format: SampleFormat): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  let count = 0;
  if (format === 'float32') {
    for (let i = 0; i + 4 <= bytes.byteLength; i += 4) {
      const s = view.getFloat32(i, true);
      if (!Number.isFinite(s)) continue;
      sum += s * s;
      count += 1;
    }
  } else if (format === 'int16') {
    for (let i = 0; i + 2 <= bytes.byteLength; i += 2) {
      const s = view.getInt16(i, true) / 32768;
      sum += s * s;
      count += 1;
    }
  } else if (format === 'int32') {
    for (let i = 0; i + 4 <= bytes.byteLength; i += 4) {
      const s = view.getInt32(i, true) / 2_147_483_647;
      sum += s * s;
      count += 1;
    }
  } else {
    return 0;
  }
  if (count === 0) return 0;
  return Math.min(1, Math.max(0, Math.sqrt(sum / count)));
}

/** Live PCM16 little-endian bytes to float32 in [-1, 1). */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
