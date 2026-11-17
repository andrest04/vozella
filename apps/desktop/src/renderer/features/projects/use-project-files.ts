import type { AddProjectFileResultDto, ProjectFileFailureDto } from '@vozella/contracts';
import { useCallback, useState } from 'react';

export interface FileProblem {
  readonly id: number;
  readonly name: string;
  /** `remove-failed` is a file that could not be taken out; the rest are why an add was refused. */
  readonly reason: ProjectFileFailureDto | 'remove-failed';
}

let nextProblemId = 0;

/**
 * Adding and removing the files of one project. A file being read shows as a pending row; every
 * file that could not be added becomes a row of its own with the reason, until it is dismissed.
 */
export function useProjectFiles(projectId: string, reload: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [problems, setProblems] = useState<readonly FileProblem[]>([]);

  const take = useCallback(
    async (results: readonly AddProjectFileResultDto[]): Promise<void> => {
      const failed = results.flatMap((result) =>
        result.ok ? [] : [{ id: (nextProblemId += 1), name: result.name, reason: result.reason }],
      );
      setProblems(failed);
      if (results.some((result) => result.ok)) await reload();
    },
    [reload],
  );

  const pick = useCallback(async (): Promise<void> => {
    setPending(true);
    try {
      const { results } = await window.vozella.invoke('projects.files.pick', { projectId });
      await take(results);
    } catch {
      setProblems([{ id: (nextProblemId += 1), name: '', reason: 'unreadable' }]);
    } finally {
      setPending(false);
    }
  }, [projectId, take]);

  const remove = useCallback(
    async (fileId: string, name: string): Promise<void> => {
      let removed: boolean;
      try {
        ({ removed } = await window.vozella.invoke('projects.files.remove', { projectId, fileId }));
      } catch {
        removed = false;
      }
      if (!removed) {
        setProblems((current) => [
          ...current,
          { id: (nextProblemId += 1), name, reason: 'remove-failed' },
        ]);
      }
      await reload();
    },
    [projectId, reload],
  );

  return {
    pending,
    problems,
    pick,
    remove,
    dismiss: (id: number): void => {
      setProblems((current) => current.filter((problem) => problem.id !== id));
    },
  };
}
