import type { ProjectDeleteResultDto, ProjectDto } from '@vozella/contracts';
import type {
  Logger,
  NewProject,
  ProjectDeleteResult,
  ProjectPatch,
  ProjectService,
  Result,
  Workspace,
} from '@vozella/core';

/** Pushes one event to every window. */
export type NotifyChanged = (event: ProjectsEvent) => void;

/** What the controller tells the windows; the handlers turn it into broadcasts. */
export type ProjectsEvent =
  | { readonly kind: 'project'; readonly projectId: string | null }
  /** Meetings changed project (a delete moved them to no project). */
  | { readonly kind: 'meetings' };

export interface ProjectsControllerDeps {
  readonly service: Pick<
    ProjectService,
    | 'list'
    | 'get'
    | 'create'
    | 'update'
    | 'setInstructions'
    | 'delete'
    | 'migrationNotice'
    | 'dismissMigrationNotice'
  >;
  readonly workspace: Pick<Workspace, 'publishSelectedProject'>;
  readonly notify: NotifyChanged;
  readonly logger: Logger;
}

type ProjectAnswer =
  | { readonly ok: true; readonly project: ProjectDto }
  | { readonly ok: false; readonly reason: Extract<Result<never>, { ok: false }>['reason'] };

const answer = (result: Result<ProjectDto>): ProjectAnswer =>
  result.ok ? { ok: true, project: result.value } : { ok: false, reason: result.reason };

/**
 * The project use cases as the wire sees them. Thin on purpose: it calls the service, shapes the
 * answer and says what changed. Validation is done by the channel schemas and by the service.
 */
export function createProjectsController(deps: ProjectsControllerDeps) {
  const { service, workspace, notify } = deps;
  return {
    list: () => service.list(),

    async get(id: string) {
      const found = await service.get(id);
      return found.ok
        ? { ok: true as const, project: found.value.project, files: found.value.files }
        : { ok: false as const, reason: found.reason };
    },

    async create(input: NewProject) {
      const result = answer(await service.create(input));
      if (result.ok) notify({ kind: 'project', projectId: result.project.id });
      return result;
    },

    async update(id: string, patch: ProjectPatch) {
      const result = answer(await service.update(id, patch));
      if (result.ok) notify({ kind: 'project', projectId: id });
      return result;
    },

    async setInstructions(id: string, instructions: string) {
      const result = answer(await service.setInstructions(id, instructions));
      if (result.ok) notify({ kind: 'project', projectId: id });
      return result;
    },

    /** Success clears the selected project: the page of a deleted project must not stay selected. */
    async delete(id: string): Promise<ProjectDeleteResultDto> {
      const result: ProjectDeleteResult = await service.delete(id);
      if (result.ok) {
        workspace.publishSelectedProject(null);
        notify({ kind: 'project', projectId: id });
        notify({ kind: 'meetings' });
      } else if (result.reason === 'partial') {
        // Some meetings moved to no project even though the project stays.
        if (result.moved > 0) notify({ kind: 'meetings' });
      }
      return result;
    },

    async migrationReport() {
      const found = await service.migrationNotice();
      return {
        report:
          found === null
            ? null
            : {
                kind: found.kind,
                projects: found.projects,
                renamed: found.renamed,
                skipped: found.skipped,
                legacyLeftovers: found.legacyLeftovers,
              },
      };
    },

    async dismissMigrationReport() {
      await service.dismissMigrationNotice();
      return {};
    },
  };
}

export type ProjectsController = ReturnType<typeof createProjectsController>;
