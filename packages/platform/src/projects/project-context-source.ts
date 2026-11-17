import type { ProjectContextSource, ProjectFileStore, ProjectRepository } from '@vozella/core';

export interface ProjectContextSourceDeps {
  readonly projects: Pick<ProjectRepository, 'get'>;
  readonly files: Pick<ProjectFileStore, 'readDocuments'>;
}

/** The instructions and extracted files of a project; null for an unknown project. */
export function createProjectContextSource(deps: ProjectContextSourceDeps): ProjectContextSource {
  return {
    async get(projectId) {
      const project = await deps.projects.get(projectId);
      if (project === null) return null;
      return {
        projectId: project.id,
        name: project.name,
        instructions: project.instructions,
        documents: await deps.files.readDocuments(project.id),
      };
    },
  };
}
