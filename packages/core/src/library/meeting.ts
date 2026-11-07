export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * How a spoken deadline relates to the meeting day. The model only classifies; code computes the
 * date. `unknown` keeps a free-text deadline (legacy `Due: Friday`) that has no kind token.
 */
export type DeadlineKind =
  | { readonly type: 'date'; readonly date: string }
  | { readonly type: 'weekday'; readonly weekday: Weekday }
  | { readonly type: 'in_days'; readonly days: number }
  | { readonly type: 'next_week' }
  | { readonly type: 'next_meeting' }
  | { readonly type: 'unknown' };

export interface ActionItemDeadline {
  /** The exact words that justify the deadline. */
  readonly quote: string;
  readonly kind: DeadlineKind;
  /** `YYYY-MM-DD` in the meeting's calendar, once resolved or confirmed. */
  readonly date?: string;
}

export interface ActionItem {
  readonly text: string;
  readonly isDone: boolean;
  readonly owner?: string;
  readonly deadline?: ActionItemDeadline;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_IN_DAYS = 3650;

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(text: string): boolean {
  const match = ISO_DAY.exec(text);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * Reads a kind token: `date:YYYY-MM-DD`, `weekday:mon..sun`, `in_days:<n>`, `next_week`,
 * `next_meeting` or `unknown` (case-insensitive). Returns null for anything else.
 */
export function parseDeadlineKind(token: string): DeadlineKind | null {
  const t = token.trim().toLowerCase();
  if (t === 'next_week') return { type: 'next_week' };
  if (t === 'next_meeting') return { type: 'next_meeting' };
  if (t === 'unknown') return { type: 'unknown' };
  const [name, value = ''] = t.split(':', 2);
  if (name === 'date' && isIsoDay(value)) return { type: 'date', date: value };
  if (name === 'weekday') {
    const weekday = WEEKDAYS.find((w) => w === value);
    if (weekday) return { type: 'weekday', weekday };
  }
  if (name === 'in_days' && /^\d{1,4}$/.test(value) && Number(value) <= MAX_IN_DAYS) {
    return { type: 'in_days', days: Number(value) };
  }
  return null;
}

/** The token form of a kind; `parseDeadlineKind` reads it back. */
export function formatDeadlineKind(kind: DeadlineKind): string {
  switch (kind.type) {
    case 'date':
      return `date:${kind.date}`;
    case 'weekday':
      return `weekday:${kind.weekday}`;
    case 'in_days':
      return `in_days:${String(kind.days)}`;
    default:
      return kind.type;
  }
}

export interface JevActionVerdict {
  readonly text: string;
  readonly relation: string;
  readonly confidence: number | null;
}

/** Typed Jev judgments for one meeting (stored as one JSON line under `## Jev`). */
export interface JevAnalysis {
  readonly meetingType: string | null;
  readonly meetingTypeConfidence: number | null;
  readonly spokenLanguage: string | null;
  readonly urgencyScore: number;
  readonly urgencyConfidence: number | null;
  readonly containsDecisions: number;
  readonly containsCommitments: number;
  readonly piiRisk: number;
  readonly summaryFaithful: number | null;
  readonly suggestedFolderId: string | null;
  readonly folderConfidence: number | null;
  readonly actionItems: readonly JevActionVerdict[];
  readonly model: string;
  readonly analyzedAt: string;
}

/** One meeting as stored in a Markdown file (spec 4.1). */
export interface MeetingRecord {
  /** Lowercase hyphenated GUID. */
  readonly id: string;
  readonly title: string;
  /** Round-trip text with seven fraction digits and a numeric offset. */
  readonly recordedAt: string;
  readonly endedAt: string | null;
  /** Absolute path. Empty when there is no recording. */
  readonly audioFilePath: string;
  /** Where the record was read from. Never written. */
  readonly sourcePath: string | null;
  readonly folderId: string | null;
  readonly summaryProvider: string | null;
  readonly calendarEventId: string | null;
  readonly calendarId: string | null;
  readonly seriesId: string | null;
  readonly joinUrl: string | null;
  readonly noteTemplateId: string | null;
  readonly attendees: readonly string[];
  readonly brief: string | null;
  readonly transcript: string | null;
  readonly summary: string | null;
  readonly actionItems: readonly ActionItem[];
  readonly jevAnalysis: JevAnalysis | null;
  /** Personal notes. */
  readonly notes: string | null;
  readonly followUp: string | null;
  readonly projectPlan: string | null;
}

/** What the Library list needs: no transcript, no summary text. */
export interface MeetingListItem {
  readonly id: string;
  readonly title: string;
  readonly recordedAt: string;
  readonly endedAt: string | null;
  readonly folderId: string | null;
  readonly snippet: string;
  readonly hasSummary: boolean;
  readonly hasTranscript: boolean;
  /** A summary is being generated. Repositories report false; the Library service fills it in. */
  readonly busy: boolean;
}

/** A markdown file that could not be read as a meeting, with the reason. */
export interface SkippedMeetingFile {
  readonly path: string;
  readonly reason: string;
}

export class MeetingFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingFormatError';
  }
}
