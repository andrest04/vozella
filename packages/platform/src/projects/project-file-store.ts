import {
  InMemoryProjectFileStore,
  type Clock,
  type Logger,
  type ProjectFileStore,
  type StorageLayout,
  type StorageStateSource,
} from '@vozella/core';
import type { DocumentExtractor } from '../chat/document-extraction';

export interface ProjectFileStoreDeps {
  readonly layout: StorageLayout;
  readonly extractor: DocumentExtractor;
  readonly state: StorageStateSource;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
}

/**
 * The context files of the projects: copied under `.vozella/projects/<id>/files`, their text
 * extracted once.
 *
 * Contracts phase stub with the final signature: it answers with the in-memory fake. The context
 * lane replaces the body.
 */
export function createProjectFileStore(deps: ProjectFileStoreDeps): ProjectFileStore {
  return new InMemoryProjectFileStore(deps.state, () => deps.clock.now().toISOString());
}
