import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFlagFileScanner, fakeCallFlagPath } from './fake-call-scanner';

describe('fake call scanner', () => {
  it('reports a call while the flag file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-flag-'));
    const flag = path.join(dir, 'call.flag');
    const scanner = createFlagFileScanner(flag);
    expect(await scanner.findMeetingWindow()).toBeNull();
    fs.writeFileSync(flag, '');
    expect(await scanner.findMeetingWindow()).toEqual({ app: 'unknown' });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await scanner.findMeetingWindow()).toBeNull();
  });

  it('names the app written in the flag file, else unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-flag-'));
    const flag = path.join(dir, 'call.flag');
    const scanner = createFlagFileScanner(flag);
    fs.writeFileSync(flag, 'teams\n');
    expect(await scanner.findMeetingWindow()).toEqual({ app: 'teams' });
    fs.writeFileSync(flag, 'webex');
    expect(await scanner.findMeetingWindow()).toEqual({ app: 'unknown' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is only honored in test mode', () => {
    const env = { VOZELLA_FAKE_CALL_FLAG: 'x' };
    expect(fakeCallFlagPath(env, true)).toBe('x');
    expect(fakeCallFlagPath(env, false)).toBeUndefined();
    expect(fakeCallFlagPath({}, true)).toBeUndefined();
  });
});
