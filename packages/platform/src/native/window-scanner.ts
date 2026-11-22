import { meetingApp, type MeetingWindowMatch, type WindowScanPort } from '@vozella/core';

export interface TopLevelWindowInfo {
  /** Process image name without ".exe". */
  readonly processName: string;
  readonly title: string;
}

/** Where the open windows come from: the native addon, or a fake in tests. */
export interface WindowLister {
  listWindows(): Promise<readonly TopLevelWindowInfo[]>;
}

/**
 * Port: the first open top-level window that is a meeting call, named by its app. Stops at the
 * first match. A listing that fails counts as "no call window", so a scan error never reaches
 * the watcher. The match never carries the window title.
 */
export class WindowScanner implements WindowScanPort {
  constructor(
    private readonly lister: WindowLister,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  async findMeetingWindow(): Promise<MeetingWindowMatch | null> {
    try {
      const windows = await this.lister.listWindows();
      for (const w of windows) {
        if (w.processName === '' || w.title === '') continue;
        const app = meetingApp(w.processName, w.title);
        if (app !== null) return { app };
      }
      return null;
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }
}
