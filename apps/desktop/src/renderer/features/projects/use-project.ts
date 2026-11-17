import type { ProjectDto, ProjectFileDto, ProjectFailureReasonDto } from '@vozella/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectDirectory } from '../meeting-list/project-directory';

export type ProjectPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';

export interface ProjectState {
  readonly phase: ProjectPhase;
  readonly project: ProjectDto | null;
  readonly files: readonly ProjectFileDto[];
  readonly reload: () => Promise<void>;
}

const unavailable = (reason: ProjectFailureReasonDto): boolean =>
  reason === 'storage-migrating' || reason === 'storage-error' || reason === 'storage-newer';

/**
 * One project and its files. The page says "not found" for an id the project list does not know,
 * and for one that disappears while the page is open: another window deleted it, and the change
 * arrives here as `projects.changed`.
 */
export function useProject(id: string): ProjectState {
  const [loaded, setLoaded] = useState<{
    readonly id: string;
    readonly phase: 'ready' | 'not-found' | 'unavailable';
    readonly project: ProjectDto | null;
    readonly files: readonly ProjectFileDto[];
  } | null>(null);
  const seq = useRef(0);
  const directoryStatus = useProjectDirectory((state) => state.status);
  const listed = useProjectDirectory((state) =>
    state.projects.some((project) => project.id === id),
  );

  const reload = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const result = await window.vozella.invoke('projects.get', { id });
      if (mine !== seq.current) return;
      if (result.ok) {
        setLoaded({ id, phase: 'ready', project: result.project, files: result.files });
      } else {
        setLoaded({
          id,
          phase: unavailable(result.reason) ? 'unavailable' : 'not-found',
          project: null,
          files: [],
        });
      }
    } catch {
      if (mine === seq.current) setLoaded({ id, phase: 'unavailable', project: null, files: [] });
    }
  }, [id]);

  useEffect(() => {
    void reload();
    const refresh = (event: { readonly projectId: string | null }): void => {
      if (event.projectId === null || event.projectId === id) void reload();
    };
    const off = window.vozella.on('projects.changed', refresh);
    return () => {
      off();
      seq.current += 1;
    };
  }, [id, reload]);

  const current = loaded?.id === id ? loaded : null;
  const gone = directoryStatus === 'ready' && !listed;
  const phase: ProjectPhase =
    current?.phase === 'not-found' || (gone && current?.phase !== 'unavailable')
      ? 'not-found'
      : (current?.phase ?? 'loading');
  return {
    phase,
    project: phase === 'not-found' ? null : (current?.project ?? null),
    files: phase === 'not-found' ? [] : (current?.files ?? []),
    reload,
  };
}
