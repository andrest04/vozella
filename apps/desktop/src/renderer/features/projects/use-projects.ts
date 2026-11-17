import type { MigrationReportDto, ProjectDto, ProjectFailureReasonDto } from '@vozella/contracts';
import { useCallback, useEffect, useState } from 'react';
import {
  refreshProjectDirectory,
  useConnectedProjectDirectory,
  type ProjectDirectoryState,
} from '../meeting-list/project-directory';

/** The projects the window knows, loaded once, kept current by `projects.changed`. */
export function useProjects(): ProjectDirectoryState {
  return useConnectedProjectDirectory();
}

/** The one-time notice about the folders that became projects, until it is dismissed. */
export function useMigrationReport(): {
  readonly report: MigrationReportDto | null;
  readonly dismiss: () => void;
} {
  const [report, setReport] = useState<MigrationReportDto | null>(null);
  useEffect(() => {
    let live = true;
    void window.vozella
      .invoke('projects.migrationReport', {})
      .then((result) => {
        if (live) setReport(result.report);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const dismiss = useCallback(() => {
    setReport(null);
    void window.vozella.invoke('projects.dismissMigrationReport', {}).catch(() => undefined);
  }, []);
  return { report, dismiss };
}

export type ProjectActionResult =
  | { readonly ok: true; readonly project: ProjectDto }
  | {
      readonly ok: false;
      readonly reason: ProjectFailureReasonDto;
      readonly message?: string | undefined;
    };

/** Creates a project, and has the shared list reloaded before the caller goes to its page. */
export async function createProject(
  name: string,
  description: string,
): Promise<ProjectActionResult> {
  try {
    const result = await window.vozella.invoke('projects.create', {
      name,
      ...(description.trim() === '' ? {} : { description }),
    });
    if (result.ok) await refreshProjectDirectory();
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: 'io-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Pins or unpins a project. */
export async function setProjectPinned(id: string, pinned: boolean): Promise<ProjectActionResult> {
  try {
    const result = await window.vozella.invoke('projects.update', { id, pinned });
    if (result.ok) await refreshProjectDirectory();
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: 'io-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The words for a project action that did not go through; null for the reasons a field explains. */
export function failureKey(
  reason: ProjectFailureReasonDto,
):
  | 'Ui_ProjectNameRequired'
  | 'Ui_ProjectNameTaken'
  | 'Ui_ProjectNameTooLong'
  | 'Ui_ProjectsUnavailableNow'
  | 'Ui_ProjectActionFailed'
  | 'Ui_ProjectDeleteBusy' {
  switch (reason) {
    case 'empty-name':
      return 'Ui_ProjectNameRequired';
    case 'name-taken':
      return 'Ui_ProjectNameTaken';
    case 'too-long':
      return 'Ui_ProjectNameTooLong';
    case 'busy':
      return 'Ui_ProjectDeleteBusy';
    case 'storage-migrating':
    case 'storage-error':
    case 'storage-newer':
      return 'Ui_ProjectsUnavailableNow';
    default:
      return 'Ui_ProjectActionFailed';
  }
}
