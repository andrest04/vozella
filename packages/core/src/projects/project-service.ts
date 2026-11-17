import type { ChatThreadRepository } from '../chat/chat-thread';
import type { MeetingBusyProbe, MeetingRepository } from '../library/ports';
import type { MeetingListItem } from '../library/meeting';
import { parseOffsetDate } from '../library/offset-date';
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_INSTRUCTIONS_MAX,
  type NewProject,
  type Project,
  type ProjectListItem,
  type ProjectPatch,
  type ProjectsOverview,
  type SkippedProject,
} from './project';
import { isProjectNameTaken, validateProjectName } from './project-names';
import type { ProjectFile } from './project-file';
import {
  storageFailureOf,
  type ProjectDeleteResult,
  type ProjectFileStore,
  type ProjectRepository,
  type Result,
  type StorageState,
} from './ports';

/** What the page shows once after the folders became projects. */
export interface MigrationNotice {
  readonly kind: 'folders-to-projects';
  readonly projects: number;
  readonly renamed: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  readonly skipped: readonly { readonly index: number; readonly reason: string }[];
  /** Older layouts that were found and not imported. */
  readonly legacyLeftovers: readonly string[];
}

/** Port: the one-time migration notice. Adapter: createMigrationNoticeStore (platform/projects). */
export interface MigrationNoticeStore {
  /** Null when there is no notice (or it was dismissed). */
  read(): Promise<MigrationNotice | null>;
  /** Clears the notice. A no-op while the storage is not ready. */
  dismiss(): Promise<void>;
}

export interface ProjectServiceDeps {
  readonly projects: ProjectRepository;
  readonly meetings: MeetingRepository;
  readonly files: ProjectFileStore;
  readonly threads: ChatThreadRepository;
  readonly busy: MeetingBusyProbe;
  /** Without it there is never a notice. */
  readonly notice?: MigrationNoticeStore;
}

/** What `projects.list` answers: the cards, the no-project summary and what could not be read. */
export interface ProjectsListing extends ProjectsOverview {
  readonly skipped: readonly SkippedProject[];
  readonly storage: StorageState;
}

export interface ProjectDetail {
  readonly project: Project;
  readonly files: readonly ProjectFile[];
}

const instantOf = (recordedAt: string): string | null => {
  const parsed = parseOffsetDate(recordedAt);
  return parsed === null ? null : new Date(parsed.ms).toISOString();
};

const newest = (dates: readonly (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  for (const date of dates) if (date != null && (best === null || date > best)) best = date;
  return best;
};

/**
 * The project use cases: create, update (names are unique by folded text), instructions, pin,
 * list (counts and last activity) and a delete that is idempotent and resumable. Writes answer
 * with a value, never a throw; while the storage is not ready the repository refuses them with a
 * `storage-*` reason.
 */
export class ProjectService {
  constructor(readonly deps: ProjectServiceDeps) {}

  async list(): Promise<ProjectsListing> {
    const { projects, meetings, files, threads } = this.deps;
    const [stored, list, fileCounts, activity] = await Promise.all([
      projects.list(),
      meetings.list(),
      files.countByProject(),
      threads.activity(),
    ]);
    const known = new Set(stored.projects.map((project) => project.id));
    const byProject = new Map<string, MeetingListItem[]>();
    const unfiled: MeetingListItem[] = [];
    for (const item of list.items) {
      if (item.projectId !== null && known.has(item.projectId)) {
        const group = byProject.get(item.projectId);
        if (group) group.push(item);
        else byProject.set(item.projectId, [item]);
      } else {
        unfiled.push(item);
      }
    }
    const newestMeeting = (items: readonly MeetingListItem[] | undefined): string | null =>
      newest((items ?? []).map((item) => instantOf(item.recordedAt)));

    const items: ProjectListItem[] = stored.projects.map((project) => {
      const own = byProject.get(project.id);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        pinned: project.pinned,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        meetingCount: own?.length ?? 0,
        fileCount: fileCounts.get(project.id) ?? 0,
        lastActivityAt:
          newest([project.updatedAt, newestMeeting(own), activity.get(project.id)]) ??
          project.updatedAt,
      };
    });
    return {
      projects: items,
      noProject: {
        meetingCount: unfiled.length,
        lastActivityAt: newest([newestMeeting(unfiled), activity.get(null)]),
      },
      skipped: stored.skipped,
      storage: projects.state(),
    };
  }

  /** The one-time notice about the folder to project migration, or null. */
  migrationNotice(): Promise<MigrationNotice | null> {
    return this.deps.notice?.read() ?? Promise.resolve(null);
  }

  async dismissMigrationNotice(): Promise<void> {
    await this.deps.notice?.dismiss();
  }

  async get(id: string): Promise<Result<ProjectDetail>> {
    const project = await this.deps.projects.get(id);
    if (project === null) return { ok: false, reason: 'not-found' };
    return { ok: true, value: { project, files: await this.deps.files.list(id) } };
  }

  async create(input: NewProject): Promise<Result<Project>> {
    const checked = validateProjectName(input.name);
    if (!checked.ok) return checked;
    const description = input.description ?? '';
    if (description.length > PROJECT_DESCRIPTION_MAX) return { ok: false, reason: 'too-long' };
    const stored = await this.deps.projects.list();
    if (isProjectNameTaken(stored.projects, checked.name, null)) {
      return { ok: false, reason: 'name-taken' };
    }
    return this.deps.projects.create({ name: checked.name, description });
  }

  /** Name, description and pin. Instructions have their own use case. */
  async update(id: string, patch: ProjectPatch): Promise<Result<Project>> {
    const clean: { name?: string; description?: string; pinned?: boolean } = {};
    if (patch.name !== undefined) {
      const checked = validateProjectName(patch.name);
      if (!checked.ok) return checked;
      clean.name = checked.name;
    }
    if (patch.description !== undefined) {
      if (patch.description.length > PROJECT_DESCRIPTION_MAX) {
        return { ok: false, reason: 'too-long' };
      }
      clean.description = patch.description;
    }
    if (patch.pinned !== undefined) clean.pinned = patch.pinned;
    if (clean.name !== undefined) {
      const stored = await this.deps.projects.list();
      if (!stored.projects.some((project) => project.id === id)) {
        return { ok: false, reason: 'not-found' };
      }
      if (isProjectNameTaken(stored.projects, clean.name, id)) {
        return { ok: false, reason: 'name-taken' };
      }
    }
    return this.deps.projects.update(id, clean);
  }

  setInstructions(id: string, instructions: string): Promise<Result<Project>> {
    if (instructions.length > PROJECT_INSTRUCTIONS_MAX) {
      return Promise.resolve({ ok: false, reason: 'too-long' });
    }
    return this.deps.projects.update(id, { instructions });
  }

  /**
   * Moves the project's meetings to no project, then discards its storage. A batch of file moves
   * is not atomic, so this never claims atomicity: a stop half way keeps the project and reports
   * how far it got, and calling again finishes the job. It never discards a project directory, so
   * a migrated parent whose directory contains a child's cannot take the child's meetings along.
   */
  async delete(id: string): Promise<ProjectDeleteResult> {
    const { projects, meetings, busy } = this.deps;
    if ((await projects.get(id)) === null) return { ok: false, reason: 'not-found' };
    const unavailable = storageFailureOf(projects.state());
    if (unavailable !== null) return { ok: false, reason: unavailable };

    const ownMeetings = async (): Promise<MeetingListItem[]> =>
      (await meetings.list()).items.filter((item) => item.projectId === id);

    const pending = await ownMeetings();
    if (pending.some((item) => busy.isBusy(item.id))) return { ok: false, reason: 'busy' };

    let moved = 0;
    await meetings.batch(async () => {
      for (const item of pending) {
        try {
          const record = await meetings.get(item.id);
          if (record === null) continue;
          await meetings.save({ ...record, projectId: null });
          moved += 1;
        } catch {
          // One that cannot move stays; the rest still go, and the count below says so.
        }
      }
    });

    const remaining = (await ownMeetings()).length;
    if (remaining > 0) return { ok: false, reason: 'partial', moved, remaining };

    const removed = await projects.delete(id);
    return removed.ok ? { ok: true } : { ok: false, reason: removed.reason };
  }
}
