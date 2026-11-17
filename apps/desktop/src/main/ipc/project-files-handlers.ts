import { projectsFilesAdd, projectsFilesPick, projectsFilesRemove } from '@vozella/contracts';
import type { Logger } from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { ProjectFilesController } from '../projects/project-files-controller';
import type { WindowDialogs } from '../window-dialogs';
import { registerRequest, type IpcServerDeps } from './ipc-server';
import type { Broadcast } from './library-handlers';

export interface ProjectFileHandlerDeps {
  readonly server: IpcServerDeps;
  readonly library: Pick<LibraryRuntime, 'projects' | 'projectFiles'>;
  readonly broadcast: Broadcast;
  readonly dialogs: WindowDialogs;
  readonly logger: Logger;
  /** The picker's file type name, already translated. */
  readonly filterName?: string;
}

/** Wires the project file channels: one line each, the rules live in the controller and the store. */
export function registerProjectFileHandlers(deps: ProjectFileHandlerDeps): void {
  const { server, library } = deps;
  const controller = new ProjectFilesController({
    files: () => library.projectFiles,
    dialogs: deps.dialogs,
    broadcast: deps.broadcast,
    logger: deps.logger,
    filterName: deps.filterName ?? 'Documents',
  });
  registerRequest(server, projectsFilesPick, ({ projectId }) => controller.pick(projectId));
  registerRequest(server, projectsFilesAdd, ({ projectId, paths }) =>
    controller.add(projectId, paths),
  );
  registerRequest(server, projectsFilesRemove, ({ projectId, fileId }) =>
    controller.remove(projectId, fileId),
  );
}
