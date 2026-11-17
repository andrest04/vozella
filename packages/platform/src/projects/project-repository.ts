import {
  InMemoryProjectRepository,
  type Clock,
  type Logger,
  type ProjectRepository,
  type StorageStateSource,
} from '@vozella/core';

export interface ProjectRepositoryDeps {
  readonly libraryRoot: string;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly state: StorageStateSource;
  /** Electron's `shell.trashItem`; without it a deleted project's storage is removed outright. */
  readonly discard?: (path: string) => Promise<void>;
}

/**
 * The file-backed project repository: `project.json` per project under `.vozella/projects`.
 *
 * Contracts phase stub with the final signature: it answers with the in-memory fake. The storage
 * lane replaces the body.
 */
export function createProjectRepository(deps: ProjectRepositoryDeps): ProjectRepository {
  return new InMemoryProjectRepository({
    state: deps.state,
    libraryRoot: deps.libraryRoot,
    now: () => deps.clock.now().toISOString(),
    newId: deps.newId,
  });
}
