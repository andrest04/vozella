import fs from 'node:fs';
import { micActivityPathFor, type PreviousAudioKeeper } from '@vozella/core';

/**
 * Renames the audio a new take replaces to `<stem> (previous).wav` beside it (B-3). Its
 * microphone activity sidecar goes along, so the kept take keeps its `[ You ]` labels and the
 * new take never reads the old activity.
 */
export function previousAudioKeeper(): PreviousAudioKeeper {
  return {
    keep: (audioPath) => {
      if (!fs.existsSync(audioPath)) return Promise.resolve(audioPath);
      const dot = audioPath.lastIndexOf('.');
      const stem = dot < 0 ? audioPath : audioPath.slice(0, dot);
      const ext = dot < 0 ? '' : audioPath.slice(dot);
      for (let n = 1; ; n += 1) {
        const candidate = `${stem} (previous${n === 1 ? '' : ` ${n}`})${ext}`;
        if (fs.existsSync(candidate)) continue;
        fs.renameSync(audioPath, candidate);
        moveSidecar(audioPath, candidate);
        return Promise.resolve(candidate);
      }
    },
  };
}

function moveSidecar(from: string, to: string): void {
  const sidecar = micActivityPathFor(from);
  if (!fs.existsSync(sidecar)) return;
  try {
    fs.renameSync(sidecar, micActivityPathFor(to));
  } catch {
    // Best effort: the new take overwrites or removes it at its own stop.
  }
}
