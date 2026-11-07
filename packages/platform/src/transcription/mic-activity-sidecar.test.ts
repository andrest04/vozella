import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { micActivityPathFor } from '@vozella/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidecarMicActivityReader, writeMicActivitySidecar } from './mic-activity-sidecar';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-mic-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mic activity sidecar files', () => {
  it('writes next to the recording and reads back the same activity', () => {
    const wav = path.join(dir, '2026-11-07 Standup.wav');
    writeMicActivitySidecar(wav, [{ startMs: 1000, endMs: 2000 }]);
    expect(fs.existsSync(micActivityPathFor(wav))).toBe(true);
    const activity = new SidecarMicActivityReader().read(wav);
    expect(activity?.dominantShare(1000, 2000)).toBe(1);
    expect(activity?.dominantShare(2000, 3000)).toBe(0);
  });

  it('reads a legacy recording (no sidecar) as no activity', () => {
    expect(new SidecarMicActivityReader().read(path.join(dir, 'old.wav'))).toBeNull();
  });

  it('reads a corrupted sidecar as no activity instead of failing the pass', () => {
    const wav = path.join(dir, 'bad.wav');
    fs.writeFileSync(micActivityPathFor(wav), '{"version":1,"ranges":[[5,1]]}');
    expect(new SidecarMicActivityReader().read(wav)).toBeNull();
  });
});
