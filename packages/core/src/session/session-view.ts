import type { MeetingRecord } from '../library/meeting';
import { evaluateRetranscription } from '../transcription/retranscription';

export type BusyReason = 'capture' | 'run' | null;

export interface RunnerStateLike {
  readonly isRunning: boolean;
  readonly meetingId: string | null;
}

export interface SessionView {
  readonly title: string;
  readonly hasMeeting: boolean;
  readonly hasTranscript: boolean;
  /** True when the recorded audio file exists. */
  readonly hasAudio: boolean;
}

export type SessionRecord = Pick<MeetingRecord, 'title' | 'transcript' | 'audioFilePath'>;

/** What the header and tabs need from the record. A missing record is an empty view. */
export function deriveSessionView(
  record: SessionRecord | null,
  fileExists: (path: string) => boolean,
): SessionView {
  if (record === null)
    return { title: '', hasMeeting: false, hasTranscript: false, hasAudio: false };
  return {
    title: record.title,
    hasMeeting: true,
    hasTranscript: (record.transcript ?? '').trim() !== '',
    hasAudio: evaluateRetranscription(record, false, fileExists) === 'Available',
  };
}

/** Rename is blocked only while a run targets this meeting. */
export function canRename(
  view: Pick<SessionView, 'hasMeeting'>,
  meetingId: string | null,
  runner: RunnerStateLike,
): boolean {
  return (
    view.hasMeeting && !(runner.isRunning && meetingId !== null && runner.meetingId === meetingId)
  );
}

/** Busy is any run or an active capture. */
export function canRetranscribe(
  view: Pick<SessionView, 'hasMeeting' | 'hasAudio'>,
  reason: BusyReason,
): boolean {
  return view.hasMeeting && view.hasAudio && reason === null;
}
