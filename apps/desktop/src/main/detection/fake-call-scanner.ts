import fs from 'node:fs';
import type { MeetingApp, MeetingWindowMatch, WindowScanPort } from '@vozella/core';

const NAMED_APPS: ReadonlySet<string> = new Set<MeetingApp>(['teams', 'zoom', 'meet']);

function readFlag(flagPath: string): MeetingWindowMatch | null {
  let text: string;
  try {
    text = fs.readFileSync(flagPath, 'utf8').trim().toLowerCase();
  } catch {
    return null;
  }
  return { app: NAMED_APPS.has(text) ? (text as MeetingApp) : 'unknown' };
}

/**
 * Test-only scanner for the e2e specs: a call is "open" while a flag file exists. The file may
 * name the app (`teams`, `zoom`, `meet`); anything else is an unknown app. Selected with
 * VOZELLA_FAKE_CALL_FLAG=<path>, and only when the app runs in test mode.
 */
export function createFlagFileScanner(flagPath: string): WindowScanPort {
  return { findMeetingWindow: () => Promise.resolve(readFlag(flagPath)) };
}

/** The flag path from the environment, or undefined outside test mode. */
export function fakeCallFlagPath(
  env: Readonly<Record<string, string | undefined>>,
  testMode: boolean,
): string | undefined {
  const value = env.VOZELLA_FAKE_CALL_FLAG;
  return testMode && value ? value : undefined;
}
