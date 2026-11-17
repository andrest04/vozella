import { describe, expect, it } from 'vitest';
import {
  computeBufferRms,
  pcm16ToFloat,
  resolveNormalizerGain,
  toMeterPercent,
  toMeterValue,
} from './level-meter';

describe('toMeterValue', () => {
  it.each([0, 1e-6, 0.0005])('is zero at or below the floor (%s)', (amplitude) => {
    expect(toMeterValue(amplitude)).toBe(0);
  });

  it('reads full scale as 1 and clamps above it', () => {
    expect(toMeterValue(1)).toBe(1);
    expect(toMeterValue(4)).toBe(1);
  });

  it('reads -30 dB as one half', () => {
    expect(toMeterValue(0.0316228)).toBeCloseTo(0.5, 4);
  });

  it('puts typical speech between 0.5 and 0.6', () => {
    const v = toMeterValue(0.05);
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(0.6);
    expect(v).toBeCloseTo(0.566, 3);
  });

  it('treats negative and NaN as zero', () => {
    expect(toMeterValue(-0.5)).toBe(0);
    expect(toMeterValue(Number.NaN)).toBe(0);
  });

  it('never reads lower for a louder input', () => {
    let last = -1;
    for (let a = 0; a <= 1; a += 0.001) {
      const v = toMeterValue(a);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('scales to a percent', () => {
    expect(toMeterPercent(1)).toBe(100);
  });
});

describe('RMS', () => {
  it('reads float32, int16 and int32 buffers and skips non-finite floats', () => {
    const f = new Float32Array([0.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(computeBufferRms(new Uint8Array(f.buffer), 'float32')).toBeCloseTo(0.5, 6);
    const i16 = new Int16Array([16384, -16384]);
    expect(computeBufferRms(new Uint8Array(i16.buffer), 'int16')).toBeCloseTo(0.5, 6);
    const i32 = new Int32Array([1_073_741_824, -1_073_741_824]);
    expect(computeBufferRms(new Uint8Array(i32.buffer), 'int32')).toBeCloseTo(0.5, 3);
  });

  it('reads other depths and empty buffers as zero and clamps to 1', () => {
    expect(computeBufferRms(new Uint8Array(12), 'int24')).toBe(0);
    expect(computeBufferRms(new Uint8Array(0), 'int16')).toBe(0);
    const loud = new Float32Array([3, -3]);
    expect(computeBufferRms(new Uint8Array(loud.buffer), 'float32')).toBe(1);
  });

  it('converts PCM16 to float32 with a 32768 divisor', () => {
    const f = pcm16ToFloat(new Uint8Array(new Int16Array([16384, -32768, 32767]).buffer));
    expect([...f]).toEqual([0.5, -1, 32767 / 32768]);
  });
});

describe('resolveNormalizerGain (kept, not wired in)', () => {
  it('leaves silence, quiet noise and loud audio unchanged', () => {
    expect(resolveNormalizerGain(0)).toBe(1);
    expect(resolveNormalizerGain(0.0009)).toBe(1);
    expect(resolveNormalizerGain(0.8)).toBe(1);
  });

  it('raises quiet speech toward the target peak', () => {
    expect(resolveNormalizerGain(0.1)).toBeCloseTo(7, 10);
  });

  it('caps the gain at 16', () => {
    expect(resolveNormalizerGain(0.01)).toBe(16);
    expect(resolveNormalizerGain(0.003)).toBe(16);
  });
});
