import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjectDirectory } from '../meeting-list/project-directory';
import { projectIdOfPath } from './navigation';

/**
 * Tells the workspace which project's page is open: its id once the project resolves, null on every
 * other route (the grid, No project, an unknown id, any other page) and when the shell goes away.
 * The tray and the recording popup start their takes in this project.
 */
export function useSelectedProjectPublisher(): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const wanted = projectIdOfPath(pathname);
  const publishedId = useProjectDirectory((state) =>
    wanted !== null && state.projects.some((project) => project.id === wanted) ? wanted : null,
  );

  useEffect(() => {
    void window.vozella.invoke('workspace.dispatch', {
      action: { type: 'publishSelectedProject', projectId: publishedId },
    });
  }, [publishedId]);

  useEffect(
    () => () => {
      void window.vozella.invoke('workspace.dispatch', {
        action: { type: 'publishSelectedProject', projectId: null },
      });
    },
    [],
  );
}
