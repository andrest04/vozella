import path from 'node:path';
import type { ProjectRepository } from '@vozella/core';
import { samePath } from '@vozella/platform';

/** Where a take goes: the project it records into and the directory of its audio. */
export interface ProjectPlacement {
  /**
   * The project a take may record into, or null for no project. An unknown project (deleted
   * meanwhile), an unreadable one (its directory answers the Inbox) and a storage that is not
   * ready all give null: starting or saving a take never fails because of its project.
   */
  resolveProject(projectId: string | null): Promise<string | null>;
  /** The directory of the project's meetings; the Inbox when the take has no usable project. */
  audioDirectory(projectId: string | null): Promise<string>;
}

/**
 * Turns the project repository into the two answers the recording needs. Never throws: any
 * failure of the repository files the take in the Inbox with no project.
 */
export function createProjectPlacement(
  projects: Pick<ProjectRepository, 'get' | 'directoryOf'>,
  libraryRoot: () => string,
): ProjectPlacement {
  // The repository answers null while it cannot place anything; the Inbox is still the Inbox.
  const inboxDirectory = async (): Promise<string> => {
    try {
      return (await projects.directoryOf(null)) ?? path.join(libraryRoot(), 'Inbox');
    } catch {
      return path.join(libraryRoot(), 'Inbox');
    }
  };

  const place = async (
    projectId: string | null,
  ): Promise<{ projectId: string | null; directory: string }> => {
    const inbox = await inboxDirectory();
    if (projectId === null) return { projectId: null, directory: inbox };
    try {
      if ((await projects.get(projectId)) === null) return { projectId: null, directory: inbox };
      const directory = await projects.directoryOf(projectId);
      // A skipped project (unsafe directory) reads as the Inbox: a take must not join it.
      if (directory === null || samePath(directory, inbox)) {
        return { projectId: null, directory: inbox };
      }
      return { projectId, directory };
    } catch {
      return { projectId: null, directory: inbox };
    }
  };

  return {
    resolveProject: async (projectId) => (await place(projectId)).projectId,
    audioDirectory: async (projectId) => (await place(projectId)).directory,
  };
}
