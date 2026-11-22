import type { PipelineRequest } from './pipeline/request';

/**
 * The calls other modules make into the recording module (session views, the shell, the pill).
 * The main process implements them in `main/recording/entry-points.ts`.
 */
export interface StartRecordingOptions {
  readonly title?: string;
  readonly projectId?: string | null;
  /** A meeting the take re-records. */
  readonly meetingId?: string | null;
}

export type ProcessAudioRequest = Omit<PipelineRequest, 'meetingId' | 'audioPath'>;

export type ProcessAudioResult =
  | { readonly started: true; readonly meetingId: string }
  | { readonly started: false; readonly reason: 'busy' };

export interface RecordingEntryPoints {
  startRecording(options?: StartRecordingOptions): Promise<{
    started: boolean;
    meetingId: string | null;
    reason?: 'busy' | 'not-ready' | 'failed' | 'cancelled';
  }>;
  stopRecording(): Promise<boolean>;
  isCaptureActive(): boolean;
  isMeetingInUse(meetingId: string): boolean;
  /** Runs the pipeline on an audio file: a re-transcription (id given) or a new meeting (null). */
  processAudioFile(
    meetingId: string | null,
    audioPath: string,
    request: ProcessAudioRequest,
  ): ProcessAudioResult;
}
