import type { ProjectListItemDto, WorkspaceActionDto } from '@vozella/contracts';
import {
  InMemoryFolderRepository,
  InMemoryMeetingRepository,
  LibraryService,
  MeetingBusyRegistry,
  renameMeeting,
  Workspace,
  type MeetingRecord,
} from '@vozella/core';

type Listener = (payload: unknown) => void;

/** A project as the list of projects returns it. */
export const projectListItem = (
  id: string,
  name: string,
  extra: Partial<ProjectListItemDto> = {},
): ProjectListItemDto => ({
  id,
  name,
  description: '',
  pinned: false,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  meetingCount: 0,
  fileCount: 0,
  lastActivityAt: '2026-09-01T12:00:00.000Z',
  ...extra,
});

export const meetingRecord = (
  id: string,
  title: string,
  recordedAt: string,
  extra: Partial<MeetingRecord> = {},
): MeetingRecord => ({
  id,
  title,
  recordedAt,
  endedAt: null,
  audioFilePath: '',
  sourcePath: null,
  projectId: null,
  summaryProvider: null,
  calendarEventId: null,
  calendarId: null,
  seriesId: null,
  joinUrl: null,
  noteTemplateId: null,
  attendees: [],
  brief: null,
  transcript: null,
  summary: null,
  actionItems: [],
  jevAnalysis: null,
  notes: null,
  followUp: null,
  projectPlan: null,
  ...extra,
});

/**
 * A `window.vozella` backed by the real Library service over in-memory repositories and the
 * real workspace hub, so page tests exercise the same rules the main process applies.
 */
export function installFakeApi(options: { startupError?: string | null } = {}) {
  const meetings = new InMemoryMeetingRepository();
  // The service still takes a folder repository until the library purge removes it.
  const folders = new InMemoryFolderRepository();
  const projects: { list: ProjectListItemDto[] } = { list: [] };
  /** Refusals to hand out: the next moves fail with this reason. */
  const failures: { move: string | null } = { move: null };
  const busy = new MeetingBusyRegistry();
  const workspace = new Workspace();
  let counter = 0;
  // A re-transcription under way blocks a rename of that meeting.
  const runner: { isRunning: boolean; meetingId: string | null } = {
    isRunning: false,
    meetingId: null,
  };
  const service = new LibraryService({
    meetings,
    folders,
    busy,
    clock: { now: () => new Date('2026-09-05T15:00:00.000Z') },
    newId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
  });
  const listeners = new Map<string, Set<Listener>>();
  const calls: { name: string; input: unknown }[] = [];
  const actions: WorkspaceActionDto[] = [];

  const emit = (name: string, payload: unknown): void => {
    for (const listener of listeners.get(name) ?? []) listener(payload);
  };

  const invoke = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case 'library.load':
        return service.load();
      case 'library.getLocation':
        return { startupError: options.startupError ?? null };
      case 'projects.list':
        return {
          projects: projects.list,
          noProject: { meetingCount: 0, lastActivityAt: null },
          skipped: [],
          storage: { status: 'ready' },
        };
      case 'library.moveMeeting': {
        if (failures.move !== null) return { ok: false, reason: failures.move };
        const record = meetings.records.get(input.meetingId as string);
        if (!record) return { ok: false, reason: 'not-found' };
        meetings.records.set(record.id, { ...record, projectId: input.projectId as string | null });
        emit('library.changed', { reason: 'meeting' });
        return { ok: true };
      }
      case 'library.deleteMeeting': {
        const result = await service.deleteMeeting(
          input.meetingId as string,
          input.mode as 'trash' | 'permanent' | undefined,
        );
        if (result.ok) emit('library.changed', { reason: 'meeting' });
        return result;
      }
      case 'library.moveMeetings': {
        const results = (input.meetingIds as string[]).map((meetingId) => {
          if (failures.move !== null) return { meetingId, ok: false, reason: failures.move };
          const record = meetings.records.get(meetingId);
          if (!record) return { meetingId, ok: false, reason: 'not-found' };
          meetings.records.set(meetingId, {
            ...record,
            projectId: input.projectId as string | null,
          });
          return { meetingId, ok: true };
        });
        if (results.some((r) => r.ok)) emit('library.changed', { reason: 'meeting' });
        return { results };
      }
      case 'library.deleteMeetings': {
        const results = await service.deleteMeetings(input as never);
        if (results.some((r) => r.ok)) emit('library.changed', { reason: 'meeting' });
        return { results };
      }
      case 'session.rename':
        return {
          status: await renameMeeting(
            { meetings, workspace, runnerState: () => runner },
            input.id as string,
            input.title as string,
          ),
        };
      case 'library.search':
        return service.search(input as never);
      case 'library.isMeetingBusy':
        return { busy: service.isMeetingBusy(input.meetingId as string) };
      case 'library.getMeeting':
        return { record: await meetings.get(input.id as string) };
      case 'workspace.getState':
        return workspace.state;
      case 'workspace.dispatch': {
        const action = input.action as WorkspaceActionDto;
        actions.push(action);
        if (action.type === 'selectMeeting') workspace.selectMeeting(action.id);
        else if (action.type === 'openSession') workspace.openSession(action.tab);
        else if (action.type === 'navigateTo') workspace.navigateTo(action.tag);
        else if (action.type === 'publishSelectedProject') {
          workspace.publishSelectedProject(action.projectId);
        }
        return { state: workspace.state };
      }
      default:
        throw new Error(`fake api: unhandled ${name}`);
    }
  };

  const api = {
    invoke,
    on: (name: string, listener: Listener) => {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(name, set);
      return () => {
        set.delete(listener);
      };
    },
  };
  Object.defineProperty(window, 'vozella', { value: api, configurable: true, writable: true });

  return { meetings, projects, failures, busy, workspace, calls, actions, emit, service, runner };
}

/** jsdom has no layout: the grid needs a height to decide which rows to render. */
export function stubLayout(height = 2000): void {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => height,
  });
}
