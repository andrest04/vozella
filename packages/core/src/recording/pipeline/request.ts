import type { LiveQaEntry } from '../../live-ask/live-take-output';

/** What the live pass of the take produced, read at Stop before the live state was cleared. */
export interface PipelineLiveTake {
  /** The rolling digest of the take, or null when there was none. */
  readonly digest: string | null;
  readonly qa: readonly LiveQaEntry[];
  /** The localized "Live Q&A" markdown block saved with the meeting notes, or null. */
  readonly notesBlock: string | null;
}

/**
 * What one take hands the pipeline. It is built before the first await at Stop, so
 * nothing the user does next can leak into the take. Times are epoch milliseconds.
 */
export interface PipelineRequest {
  readonly meetingId: string;
  readonly audioPath: string;
  readonly recordedAtMs: number;
  /** Null when the end is unknown. */
  readonly endedAtMs: number | null;
  readonly title: string;
  /** The live transcript, or null so the offline pass becomes the transcript. */
  readonly liveDraft: string | null;
  /**
   * The live draft is already the transcript of the whole recording, so the pass after Stop is
   * skipped. Only a cloud engine sets it, when its live pass transcribed every sample: uploading
   * the audio again would spend the provider's hourly allowance for the same text. Absent or
   * false, the pass after Stop runs as always.
   */
  readonly liveDraftIsFinal?: boolean;
  /** The time the user paused, in milliseconds. Passed to the offline pass as clock skew. */
  readonly pausedDurationMs: number;
  readonly projectId: string | null;
  /** Elapsed milliseconds of the highlights marked during the take. */
  readonly highlightsMs: readonly number[];
  /** The live digest and Q&A of the take: context for the summary, Q&A saved with the notes. */
  readonly liveTake?: PipelineLiveTake;
  readonly agenda?: string | null;
  readonly noteTemplateId?: string | null;
  readonly templateInstructions?: string | null;
  /**
   * Kept only so frontmatter that already exists on disk survives a save (the calendar features do not exist; the keys are still read and written).
   */
  readonly calendarEventId?: string | null;
  readonly calendarId?: string | null;
  readonly seriesId?: string | null;
  readonly joinUrl?: string | null;
  readonly attendees?: readonly string[];
  readonly brief?: string | null;
}
