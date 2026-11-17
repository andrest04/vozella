import {
  libraryChanged,
  projectsChanged,
  projectsCreate,
  projectsDelete,
  projectsDismissMigrationReport,
  projectsGet,
  projectsList,
  projectsMigrationReport,
  projectsSetInstructions,
  projectsUpdate,
} from '@vozella/contracts';
import type { Logger, Workspace } from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { createProjectsController, type ProjectsEvent } from '../projects/projects-controller';
import type { WindowDialogs } from '../window-dialogs';
import { registerRequest, type IpcServerDeps } from './ipc-server';
import type { Broadcast } from './library-handlers';

export interface ProjectHandlerDeps {
  readonly server: IpcServerDeps;
  readonly library: Pick<LibraryRuntime, 'projects' | 'projectService' | 'chatThreads'>;
  readonly workspace: Workspace;
  readonly broadcast: Broadcast;
  readonly dialogs: WindowDialogs;
  readonly logger: Logger;
}

/**
 * Wires the project channels over the controller: one line per channel. A change is announced as
 * `projects.changed` and `library.changed` (reason `project`, or `meeting` when meetings moved).
 */
export function registerProjectHandlers(deps: ProjectHandlerDeps): void {
  const { server, library, broadcast } = deps;
  const notify = (event: ProjectsEvent): void => {
    if (event.kind === 'project') {
      broadcast(projectsChanged, { reason: 'project', projectId: event.projectId });
      broadcast(libraryChanged, { reason: 'project' });
    } else {
      broadcast(libraryChanged, { reason: 'meeting' });
    }
  };
  const controller = createProjectsController({
    service: library.projectService,
    workspace: deps.workspace,
    notify,
    logger: deps.logger,
  });

  registerRequest(server, projectsList, () => controller.list());
  registerRequest(server, projectsGet, ({ id }) => controller.get(id));
  registerRequest(server, projectsCreate, (input) => controller.create(input));
  registerRequest(server, projectsUpdate, ({ id, ...patch }) => controller.update(id, patch));
  registerRequest(server, projectsSetInstructions, ({ id, instructions }) =>
    controller.setInstructions(id, instructions),
  );
  registerRequest(server, projectsDelete, ({ id }) => controller.delete(id));
  registerRequest(server, projectsMigrationReport, () => controller.migrationReport());
  registerRequest(server, projectsDismissMigrationReport, () =>
    controller.dismissMigrationReport(),
  );
}
