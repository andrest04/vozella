import type { ChatThreadRepository } from '../chat/chat-thread';
import type { MeetingBusyProbe, MeetingRepository } from '../library/ports';
import type {
  NewProject,
  Project,
  ProjectPatch,
  ProjectsOverview,
  SkippedProject,
} from './project';
import type { ProjectFile } from './project-file';
import type {
  ProjectDeleteResult,
  ProjectFileStore,
  ProjectRepository,
  Result,
  StorageState,
} from './ports';

export interface ProjectServiceDeps {
  readonly projects: ProjectRepository;
  readonly meetings: MeetingRepository;
  readonly files: ProjectFileStore;
  readonly threads: ChatThreadRepository;
  readonly busy: MeetingBusyProbe;
}

/** What `projects.list` answers: the cards, the no-project summary and what could not be read. */
export interface ProjectsListing extends ProjectsOverview {
  readonly skipped: readonly SkippedProject[];
  readonly storage: StorageState;
}

export interface ProjectDetail {
  readonly project: Project;
  readonly files: readonly ProjectFile[];
}

const NOT_IMPLEMENTED = 'ProjectService is a stub until the storage lane replaces it.';

/**
 * The project use cases: create, update (names are unique by folded text), instructions, pin,
 * list (counts and last activity) and a delete that is idempotent and resumable.
 *
 * Contracts phase stub: the signatures are final, the bodies throw. The storage lane replaces them.
 */
export class ProjectService {
  constructor(readonly deps: ProjectServiceDeps) {}

  list(): Promise<ProjectsListing> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  get(_id: string): Promise<Result<ProjectDetail>> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  create(_input: NewProject): Promise<Result<Project>> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  /** Name, description and pin. Instructions have their own use case. */
  update(_id: string, _patch: ProjectPatch): Promise<Result<Project>> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  setInstructions(_id: string, _instructions: string): Promise<Result<Project>> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  /**
   * Moves the project's meetings to no project, then discards its storage. A stop half way keeps
   * the project and reports how far it got; calling again finishes the job.
   */
  delete(_id: string): Promise<ProjectDeleteResult> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
}
