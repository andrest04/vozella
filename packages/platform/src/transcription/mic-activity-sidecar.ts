import fs from 'node:fs';
import {
  MicActivityTimeline,
  micActivityPathFor,
  parseMicActivity,
  serializeMicActivity,
  type MicActivity,
  type MicActivityRange,
  type MicActivityReader,
} from '@vozella/core';

/** Reads `<name>.mic.json` next to `<name>.wav`. Missing or invalid: null, never a throw. */
export class SidecarMicActivityReader implements MicActivityReader {
  read(audioPath: string): MicActivity | null {
    let text: string;
    try {
      text = fs.readFileSync(micActivityPathFor(audioPath), 'utf8');
    } catch {
      return null;
    }
    const ranges = parseMicActivity(text);
    return ranges === null ? null : new MicActivityTimeline(ranges);
  }
}

/** Writes the sidecar of a finished take, next to its WAV. */
export function writeMicActivitySidecar(
  audioPath: string,
  ranges: readonly MicActivityRange[],
): void {
  fs.writeFileSync(micActivityPathFor(audioPath), serializeMicActivity(ranges), 'utf8');
}

/** Removes the sidecar of a recording, if any. Best effort: a leftover only costs a label. */
export function removeMicActivitySidecar(audioPath: string): void {
  try {
    fs.rmSync(micActivityPathFor(audioPath), { force: true });
  } catch {
    // A locked sidecar is replaced at the next stop of a take with a microphone.
  }
}
