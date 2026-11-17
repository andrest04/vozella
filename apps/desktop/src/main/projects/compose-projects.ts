import type { Logger, Workspace } from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { registerProjectFileHandlers } from '../ipc/project-files-handlers';
import { registerProjectHandlers } from '../ipc/projects-handlers';
import type { IpcServerDeps } from '../ipc/ipc-server';
import type { Broadcast } from '../ipc/library-handlers';
import type { WindowDialogs } from '../window-dialogs';

export interface ComposeProjectsDeps {
  readonly library: Pick<
    LibraryRuntime,
    'projects' | 'projectService' | 'projectFiles' | 'chatThreads'
  >;
  readonly workspace: Workspace;
  readonly broadcast: Broadcast;
  readonly server: IpcServerDeps;
  readonly dialogs: WindowDialogs;
  /** Already scoped to the projects (`logger.child('projects')`). */
  readonly logger: Logger;
}

/**
 * The projects module: the project channels (storage lane) and the project file channels
 * (context lane). Both register here and nowhere else.
 */
export function composeProjects(deps: ComposeProjectsDeps): void {
  const { library, server, broadcast, dialogs, logger } = deps;
  registerProjectHandlers({
    server,
    library,
    workspace: deps.workspace,
    broadcast,
    dialogs,
    logger,
  });
  registerProjectFileHandlers({ server, library, broadcast, dialogs, logger });
}
