/*
 * What the real-provider speech tests share: the opt-in switch, the WAV they send and how it is
 * read. Nothing here runs unless `VOZELLA_REAL_STT=1`; see the header of each
 * `real-*.integration.test.ts` for what it costs and sends.
 */
import fs from 'node:fs';

/** The real-provider tests run only when this is true. */
export const realSttEnabled = process.env.VOZELLA_REAL_STT === '1';
/** A mono PCM16 WAV with speech, or blank when none was given. */
export const realSttWavPath = process.env.VOZELLA_REAL_STT_WAV ?? '';
/** The app language tag sent with the audio. */
export const realSttLanguage = process.env.VOZELLA_REAL_STT_LANGUAGE ?? 'en-US';

export interface Pcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** Reads a mono PCM16 WAV whatever its header length, by walking the RIFF chunks. */
export function readMonoPcm16(file: string): Pcm {
  const bytes = fs.readFileSync(file);
  let sampleRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const channels = bytes.readUInt16LE(body + 2);
      const bits = bytes.readUInt16LE(body + 14);
      if (channels !== 1 || bits !== 16) {
        throw new Error(`${file} must be mono PCM16; it has ${channels} channels of ${bits} bits`);
      }
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (id === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = bytes.readInt16LE(body + i * 2) / 32768;
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

/** Half a second of a quiet tone: enough to be valid audio for the rejected-key tests. */
export function tone(): Pcm {
  const sampleRate = 16_000;
  const samples = new Float32Array(sampleRate / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return { samples, sampleRate };
}

/** The length of the audio in milliseconds. */
export const pcmMs = (pcm: Pcm): number => (pcm.samples.length / pcm.sampleRate) * 1000;
