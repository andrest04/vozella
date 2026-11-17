import {
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

const NOT_YET = 'Projects are not available yet.';

/**
 * Wires the project channels. Contracts phase stub: every channel answers with an empty or
 * "not available" value so the app runs; the storage lane replaces the bodies with the
 * controller over `ProjectService`.
 */
export function registerProjectHandlers(deps: ProjectHandlerDeps): void {
  const { server } = deps;
  registerRequest(server, projectsList, () => ({
    projects: [],
    noProject: { meetingCount: 0, lastActivityAt: null },
    skipped: [],
    storage: { status: 'ready' as const },
  }));
  registerRequest(server, projectsGet, () => ({
    ok: false as const,
    reason: 'not-found' as const,
  }));
  registerRequest(server, projectsCreate, () => ({
    ok: false as const,
    reason: 'io-failed' as const,
    message: NOT_YET,
  }));
  registerRequest(server, projectsUpdate, () => ({
    ok: false as const,
    reason: 'not-found' as const,
  }));
  registerRequest(server, projectsSetInstructions, () => ({
    ok: false as const,
    reason: 'not-found' as const,
  }));
  registerRequest(server, projectsDelete, () => ({
    ok: false as const,
    reason: 'not-found' as const,
  }));
  registerRequest(server, projectsMigrationReport, () => ({ report: null }));
  registerRequest(server, projectsDismissMigrationReport, () => ({}));
}
