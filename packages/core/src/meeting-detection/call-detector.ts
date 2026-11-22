const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi']);
const MEET_CODE = /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i;
// Word boundaries: "Calls | Microsoft Teams" is not a call, "Call with Ana" is.
const TEAMS_CALL = /\b(?:meeting|call)\b/i;

/**
 * The app a detected call runs in, so the prompt can name it. `unknown` is a call whose app the
 * detector cannot tell (a test scanner, or a future rule); the prompt then uses its generic copy.
 */
export type MeetingApp = 'teams' | 'zoom' | 'meet' | 'unknown';

/** The first meeting call window a scan found. Never carries the window title. */
export interface MeetingWindowMatch {
  readonly app: MeetingApp;
}

/** The app of a process and window title that look like a meeting call, or null for no call. */
export function meetingApp(processName: string, windowTitle: string): MeetingApp | null {
  const proc = processName.trim().toLowerCase();
  if (proc === '') return null;
  const title = windowTitle;
  const lower = title.toLowerCase();
  // CptHost is the process Zoom runs a meeting in.
  if (proc === 'cpthost') return 'zoom';
  if (proc === 'zoom') {
    return lower.includes('zoom meeting') || lower.includes('zoom webinar') ? 'zoom' : null;
  }
  if (proc === 'teams' || proc === 'ms-teams') return TEAMS_CALL.test(title) ? 'teams' : null;
  if (BROWSERS.has(proc)) return MEET_CODE.test(title) && lower.includes('meet') ? 'meet' : null;
  return null;
}

/** Decides whether a process or window title looks like a meeting call. */
export function isMeeting(processName: string, windowTitle: string): boolean {
  return meetingApp(processName, windowTitle) !== null;
}
