import { projectsFilesAdd, projectsFilesPick, projectsFilesRemove } from '@vozella/contracts';
import type { Logger } from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import type { WindowDialogs } from '../window-dialogs';
import { registerRequest, type IpcServerDeps } from './ipc-server';
import type { Broadcast } from './library-handlers';

export interface ProjectFileHandlerDeps {
  readonly server: IpcServerDeps;
  readonly library: Pick<LibraryRuntime, 'projects' | 'projectFiles'>;
  readonly broadcast: Broadcast;
  readonly dialogs: WindowDialogs;
  readonly logger: Logger;
}

/**
 * Wires the project file channels. Contracts phase stub: nothing is picked, added or removed;
 * the context lane replaces the bodies with the controller over `ProjectFileStore`.
 */
export function registerProjectFileHandlers(deps: ProjectFileHandlerDeps): void {
  const { server } = deps;
  registerRequest(server, projectsFilesPick, () => ({ results: [] }));
  registerRequest(server, projectsFilesAdd, () => ({ results: [] }));
  registerRequest(server, projectsFilesRemove, () => ({ removed: false }));
}
