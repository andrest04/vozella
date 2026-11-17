import { storageFailureOf, type ProjectRepository } from '../projects/ports';
import { LibraryFileCorruptError, MeetingTrashError } from './errors';
import { isInLibraryView, type LibraryView } from './library-view';
import type { MeetingListItem, ShadowedMeeting, SkippedMeetingFile } from './meeting';
import { searchMeetings, type SearchHit } from './meeting-search';
import type { MeetingBusyProbe, MeetingDeleteMode, MeetingRepository } from './ports';

export type FailureReason =
  | 'not-found'
  | 'busy'
  | 'corrupt'
  | 'io-failed'
  | 'trash-failed'
  /** The projects are not available right now, so a meeting cannot be placed in one. */
  | 'storage-migrating'
  | 'storage-error'
  | 'storage-newer';

export interface Failure {
  readonly ok: false;
  readonly reason: FailureReason;
  /** The error text for `io-failed` and `trash-failed`, shown next to a localized lead-in. */
  readonly message?: string;
}

export type DoneResult = { readonly ok: true } | Failure;
/** One meeting's result in a bulk action. */
export type MeetingOutcome = { readonly meetingId: string } & DoneResult;
export type LoadResult =
  | {
      readonly ok: true;
      readonly meetings: readonly MeetingListItem[];
      readonly skipped: readonly SkippedMeetingFile[];
      readonly shadowed: readonly ShadowedMeeting[];
    }
  | Failure;

export interface SearchResult {
  readonly requestId: number;
  /** A newer search replaced this one, so its hits are empty and mean nothing. */
  readonly stale: boolean;
  readonly hits: readonly SearchHit[];
}

export interface LibraryDeps {
  readonly meetings: MeetingRepository;
  readonly projects: Pick<ProjectRepository, 'get' | 'list' | 'state'>;
  readonly busy: MeetingBusyProbe;
}

function failure(error: unknown): Failure {
  if (error instanceof LibraryFileCorruptError) {
    return { ok: false, reason: 'corrupt', message: error.message };
  }
  if (error instanceof MeetingTrashError) {
    return { ok: false, reason: 'trash-failed', message: error.message };
  }
  return {
    ok: false,
    reason: 'io-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The Library page's use cases, without any view state. Every call reads fresh data,
 * and no call mutates records it was given, so a failed save leaves nothing half done.
 * Projects have their own use cases in `ProjectService`.
 */
export class LibraryService {
  private latestSearch = 0;

  constructor(private readonly deps: LibraryDeps) {}

  async load(): Promise<LoadResult> {
    try {
      const list = await this.deps.meetings.list();
      const meetings = list.items.map((item) =>
        this.deps.busy.isBusy(item.id) ? { ...item, busy: true } : item,
      );
      return { ok: true, meetings, skipped: list.skipped, shadowed: list.shadowed };
    } catch (error) {
      return failure(error);
    }
  }

  /** Full text across a view. Only the newest request runs to the end. */
  async search(input: {
    query: string;
    scope: LibraryView;
    requestId: number;
  }): Promise<SearchResult> {
    this.latestSearch += 1;
    const own = this.latestSearch;
    const isStale = (): boolean => own !== this.latestSearch;
    const known = await this.knownProjectIds();
    const hits = await searchMeetings({
      bodies: this.deps.meetings.bodies((item) => isInLibraryView(input.scope, known, item)),
      query: input.query,
      isStale,
    });
    return hits === null
      ? { requestId: input.requestId, stale: true, hits: [] }
      : { requestId: input.requestId, stale: false, hits };
  }

  /** Projects that cannot be read leave meetings findable: as everywhere else, they read as no project. */
  private async knownProjectIds(): Promise<ReadonlySet<string>> {
    try {
      return new Set((await this.deps.projects.list()).projects.map((project) => project.id));
    } catch {
      return new Set();
    }
  }

  isMeetingBusy(meetingId: string): boolean {
    return this.deps.busy.isBusy(meetingId);
  }

  /**
   * Files the meeting under a project (or none). Refused while the storage is not ready: the
   * meeting repository would leave the files where they are, so the change could not be honored.
   */
  async moveMeeting(input: { meetingId: string; projectId: string | null }): Promise<DoneResult> {
    if (this.deps.busy.isBusy(input.meetingId)) return { ok: false, reason: 'busy' };
    const unavailable = storageFailureOf(this.deps.projects.state());
    if (unavailable !== null) return { ok: false, reason: unavailable };
    try {
      const record = await this.deps.meetings.get(input.meetingId);
      if (record === null) return { ok: false, reason: 'not-found' };
      if (input.projectId !== null && (await this.deps.projects.get(input.projectId)) === null) {
        return { ok: false, reason: 'not-found' };
      }
      await this.deps.meetings.save({ ...record, projectId: input.projectId });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async deleteMeeting(id: string, mode: MeetingDeleteMode = 'trash'): Promise<DoneResult> {
    if (this.deps.busy.isBusy(id)) return { ok: false, reason: 'busy' };
    try {
      await this.deps.meetings.delete(id, mode);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  /** Each meeting on its own: one that cannot move stays and the rest still go. */
  async moveMeetings(input: {
    meetingIds: readonly string[];
    projectId: string | null;
  }): Promise<readonly MeetingOutcome[]> {
    return this.eachMeeting(input.meetingIds, (meetingId) =>
      this.moveMeeting({ meetingId, projectId: input.projectId }),
    );
  }

  /** Each meeting on its own: one that cannot go stays listed and the rest still go. */
  async deleteMeetings(input: {
    meetingIds: readonly string[];
    mode: MeetingDeleteMode;
  }): Promise<readonly MeetingOutcome[]> {
    return this.eachMeeting(input.meetingIds, (id) => this.deleteMeeting(id, input.mode));
  }

  private async eachMeeting(
    meetingIds: readonly string[],
    run: (meetingId: string) => Promise<DoneResult>,
  ): Promise<readonly MeetingOutcome[]> {
    return this.deps.meetings.batch(async () => {
      const outcomes: MeetingOutcome[] = [];
      for (const meetingId of new Set(meetingIds)) {
        outcomes.push({ meetingId, ...(await run(meetingId)) });
      }
      return outcomes;
    });
  }
}
