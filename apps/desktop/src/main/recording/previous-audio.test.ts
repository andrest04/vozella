import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previousAudioKeeper } from './previous-audio';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-previous-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('previousAudioKeeper (B-3)', () => {
  it('renames the replaced take beside it, with its microphone activity', async () => {
    const wav = path.join(dir, 'take.wav');
    fs.writeFileSync(wav, 'RIFF');
    fs.writeFileSync(path.join(dir, 'take.mic.json'), '{}');
    const kept = await previousAudioKeeper().keep(wav);
    expect(kept).toBe(path.join(dir, 'take (previous).wav'));
    expect(fs.readdirSync(dir).sort()).toEqual(['take (previous).mic.json', 'take (previous).wav']);
  });

  it('picks the next free name and works without a sidecar', async () => {
    const wav = path.join(dir, 'take.wav');
    fs.writeFileSync(path.join(dir, 'take (previous).wav'), 'OLD');
    fs.writeFileSync(wav, 'RIFF');
    expect(await previousAudioKeeper().keep(wav)).toBe(path.join(dir, 'take (previous 2).wav'));
  });

  it('keeps nothing when there is no audio', async () => {
    const wav = path.join(dir, 'none.wav');
    expect(await previousAudioKeeper().keep(wav)).toBe(wav);
  });
});
