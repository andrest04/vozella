import type {
  AddProjectFileResultDto,
  ChatThreadSummaryDto,
  MeetingListItemDto,
  MigrationReportDto,
  ProjectDeleteResultDto,
  ProjectDto,
  ProjectFileDto,
  ProjectListItemDto,
  SkippedProjectDto,
  StorageStateDto,
} from '@vozella/contracts';
import { guid, projectItem, projectOf } from './project-fixtures';
import { installVozella, type VozellaMock } from './vozella-mock';

export interface ProjectsWorld {
  projects: ProjectListItemDto[];
  details: Map<string, { project: ProjectDto; files: ProjectFileDto[] }>;
  noProject: { meetingCount: number; lastActivityAt: string | null };
  skipped: SkippedProjectDto[];
  storage: StorageStateDto;
  report: MigrationReportDto | null;
  meetings: MeetingListItemDto[];
  threads: Map<string | null, ChatThreadSummaryDto[]>;
  /** What the next `projects.files.pick` answers. */
  pickResults: AddProjectFileResultDto[];
  /** What the next `projects.delete` answers. */
  deleteResult: ProjectDeleteResultDto;
}

/**
 * A small in memory main process for the Projects pages: the project list, one detail per
 * project, files, chats and the library, all behind a typed `window.vozella`. A test changes the
 * world and emits the event main would, exactly like the real thing.
 */
export function installProjectsWorld(setup: (world: ProjectsWorld) => void = () => undefined): {
  mock: VozellaMock;
  world: ProjectsWorld;
} {
  const world: ProjectsWorld = {
    projects: [],
    details: new Map(),
    noProject: { meetingCount: 0, lastActivityAt: null },
    skipped: [],
    storage: { status: 'ready' },
    report: null,
    meetings: [],
    threads: new Map(),
    pickResults: [],
    deleteResult: { ok: true },
  };
  setup(world);
  for (const item of world.projects) {
    if (!world.details.has(item.id)) {
      world.details.set(item.id, {
        project: {
          id: item.id,
          name: item.name,
          description: item.description,
          instructions: '',
          pinned: item.pinned,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        },
        files: [],
      });
    }
  }
  const folded = (text: string): string =>
    text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  const mock = installVozella({
    'projects.list': () => ({
      projects: world.projects,
      noProject: world.noProject,
      skipped: world.skipped,
      storage: world.storage,
    }),
    'projects.get': ({ id }) => {
      const detail = world.details.get(id);
      return detail
        ? { ok: true as const, project: detail.project, files: detail.files }
        : { ok: false as const, reason: 'not-found' as const };
    },
    'projects.create': ({ name, description }) => {
      const trimmed = name.trim();
      if (trimmed === '') return { ok: false as const, reason: 'empty-name' as const };
      if (world.projects.some((p) => folded(p.name) === folded(trimmed))) {
        return { ok: false as const, reason: 'name-taken' as const };
      }
      const n = 500 + world.projects.length;
      const item = projectItem(n, trimmed, { description: description ?? '' });
      world.projects.push(item);
      const project = projectOf(n, trimmed, { description: description ?? '' });
      world.details.set(item.id, { project, files: [] });
      return { ok: true as const, project };
    },
    'projects.update': ({ id, name, description, pinned }) => {
      const detail = world.details.get(id);
      if (!detail) return { ok: false as const, reason: 'not-found' as const };
      if (name !== undefined) {
        if (name.trim() === '') return { ok: false as const, reason: 'empty-name' as const };
        if (world.projects.some((p) => p.id !== id && folded(p.name) === folded(name.trim()))) {
          return { ok: false as const, reason: 'name-taken' as const };
        }
      }
      detail.project = {
        ...detail.project,
        ...(name === undefined ? {} : { name: name.trim() }),
        ...(description === undefined ? {} : { description }),
        ...(pinned === undefined ? {} : { pinned }),
      };
      world.projects = world.projects.map((p) =>
        p.id === id
          ? {
              ...p,
              name: detail.project.name,
              description: detail.project.description,
              pinned: detail.project.pinned,
            }
          : p,
      );
      return { ok: true as const, project: detail.project };
    },
    'projects.setInstructions': ({ id, instructions }) => {
      const detail = world.details.get(id);
      if (!detail) return { ok: false as const, reason: 'not-found' as const };
      detail.project = { ...detail.project, instructions };
      return { ok: true as const, project: detail.project };
    },
    'projects.delete': ({ id }) => {
      if (world.deleteResult.ok) {
        world.projects = world.projects.filter((p) => p.id !== id);
        world.details.delete(id);
      }
      return world.deleteResult;
    },
    'projects.files.pick': ({ projectId }) => {
      const detail = world.details.get(projectId);
      for (const result of world.pickResults) if (result.ok) detail?.files.push(result.file);
      return { results: world.pickResults };
    },
    'projects.files.remove': ({ projectId, fileId }) => {
      const detail = world.details.get(projectId);
      if (detail) detail.files = detail.files.filter((f) => f.id !== fileId);
      return { removed: true };
    },
    'projects.migrationReport': () => ({ report: world.report }),
    'projects.dismissMigrationReport': () => {
      world.report = null;
      return {};
    },
    'library.load': () => ({
      ok: true as const,
      meetings: world.meetings,
      skipped: [],
      shadowed: [],
    }),
    'library.search': ({ requestId }) => ({ requestId, stale: false, hits: [] }),
    'library.getMeeting': () => ({ record: null }),
    'chat.threads.list': ({ projectId }) => ({ threads: world.threads.get(projectId) ?? [] }),
    'chat.threads.rename': ({ projectId, id, title }) => {
      world.threads.set(
        projectId,
        (world.threads.get(projectId) ?? []).map((t) => (t.id === id ? { ...t, title } : t)),
      );
      return { ok: true };
    },
    'chat.threads.delete': ({ projectId, id }) => {
      world.threads.set(
        projectId,
        (world.threads.get(projectId) ?? []).filter((t) => t.id !== id),
      );
      return { ok: true };
    },
    'workspace.dispatch': () => ({ state: {} as never }),
  });
  return { mock, world };
}

export { guid };
