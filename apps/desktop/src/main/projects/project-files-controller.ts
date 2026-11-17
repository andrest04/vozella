import { PROJECT_FILES_PICK_MAX, projectsChanged } from '@vozella/contracts';
import {
  ATTACHMENT_EXTENSIONS,
  attachmentKindForName,
  type AddProjectFileResult,
  type Logger,
  type ProjectFileStore,
} from '@vozella/core';
import type { Broadcast } from '../ipc/library-handlers';
import type { WindowDialogs } from '../window-dialogs';

export interface ProjectFilesControllerDeps {
  /** Read on every call: the library runtime swaps its services when the location changes. */
  readonly files: () => Pick<ProjectFileStore, 'add' | 'remove'>;
  readonly dialogs: Pick<WindowDialogs, 'showOpenDialog'>;
  readonly broadcast: Broadcast;
  readonly logger: Logger;
  /** The name of the picker's file type filter, already translated. */
  readonly filterName: string;
}

/** Context file extensions: every attachment type except images, which a project does not keep. */
const CONTEXT_EXTENSIONS = ATTACHMENT_EXTENSIONS.filter(
  (extension) => attachmentKindForName(`x.${extension}`) !== 'image',
);

/**
 * Adds and removes the context files of a project. The page never sees a storage path: picking
 * happens here, and every path (picked or dropped) is validated again by the store before it is
 * read.
 */
export class ProjectFilesController {
  constructor(private readonly deps: ProjectFilesControllerDeps) {}

  /** Opens the picker. An empty list means the user cancelled. */
  async pick(projectId: string): Promise<{ results: AddProjectFileResult[] }> {
    const picked = await this.deps.dialogs.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: this.deps.filterName, extensions: [...CONTEXT_EXTENSIONS] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { results: [] };
    return this.add(projectId, picked.filePaths);
  }

  /** One result per path; a bad file never stops the others. */
  async add(
    projectId: string,
    paths: readonly string[],
  ): Promise<{ results: AddProjectFileResult[] }> {
    const unique = [...new Set(paths)].slice(0, PROJECT_FILES_PICK_MAX);
    const results: AddProjectFileResult[] = [];
    for (const sourcePath of unique) {
      results.push(await this.addOne(projectId, sourcePath));
    }
    if (results.some((result) => result.ok)) this.changed(projectId);
    return { results };
  }

  async remove(projectId: string, fileId: string): Promise<{ removed: boolean }> {
    let removed = false;
    try {
      removed = await this.deps.files().remove(projectId, fileId);
    } catch (error) {
      this.deps.logger.error('project file not removed', { error });
    }
    if (removed) this.changed(projectId);
    return { removed };
  }

  private async addOne(projectId: string, sourcePath: string): Promise<AddProjectFileResult> {
    try {
      return await this.deps.files().add(projectId, sourcePath);
    } catch (error) {
      this.deps.logger.error('project file not added', { error });
      return {
        ok: false,
        name: sourcePath.split(/[\\/]/).pop() ?? sourcePath,
        reason: 'unreadable',
      };
    }
  }

  private changed(projectId: string): void {
    this.deps.broadcast(projectsChanged, { reason: 'files', projectId });
  }
}
