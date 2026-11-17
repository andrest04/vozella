import type { AttachedDocument } from '../chat/attachments';
import type { NewProject, Project, ProjectPatch, SkippedProject } from './project';
import type { AddProjectFileResult, ProjectFile } from './project-file';

/** Writes answer with a value, never a throw. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ProjectFailure };

export type ProjectFailure =
  | 'empty-name'
  | 'name-taken'
  | 'too-long'
  | 'not-found'
  | 'busy'
  | 'corrupt'
  | 'io-failed'
  | 'trash-failed'
  | 'storage-migrating'
  | 'storage-error'
  | 'storage-newer';

/**
 * The state of the library storage, held by the library runtime and read by every adapter. Unless
 * it is `ready`, the project, file and thread stores refuse every write.
 */
export type StorageState =
  | { readonly status: 'migrating' }
  | { readonly status: 'ready' }
  /** A migration step threw or the old folder list was unreadable. */
  | { readonly status: 'error'; readonly message: string }
  /** The manifest is newer than this app understands (`StorageTooNewError`). */
  | { readonly status: 'newer'; readonly found: number; readonly supported: number };

/** Read side of the storage state, so an adapter always sees the current value. */
export interface StorageStateSource {
  current(): StorageState;
}

/** The failure reason a write returns while the storage is not ready, or null when it is. */
export function storageFailureOf(
  state: StorageState,
): 'storage-migrating' | 'storage-error' | 'storage-newer' | null {
  switch (state.status) {
    case 'ready':
      return null;
    case 'migrating':
      return 'storage-migrating';
    case 'error':
      return 'storage-error';
    case 'newer':
      return 'storage-newer';
  }
}

/** Delete is resumable: a stop half way keeps the project and says how far it got. */
export type ProjectDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ProjectFailure }
  | {
      readonly ok: false;
      readonly reason: 'partial';
      readonly moved: number;
      readonly remaining: number;
    };

/** Port: the projects. Adapter: createProjectRepository (platform/projects). */
export interface ProjectRepository {
  state(): StorageState;
  list(): Promise<{
    readonly projects: readonly Project[];
    readonly skipped: readonly SkippedProject[];
  }>;
  get(id: string): Promise<Project | null>;
  /** Allocates the id and the frozen directory. */
  create(input: NewProject): Promise<Result<Project>>;
  update(id: string, patch: ProjectPatch): Promise<Result<Project>>;
  /** Discards `.vozella/projects/<id>` only, never the project's meeting directory. */
  delete(id: string): Promise<Result<void>>;
  /**
   * The absolute directory a meeting of this project is saved in. A null or unknown id is the
   * Inbox. Null means "cannot place now" (the storage is not ready, or the project is skipped):
   * the meeting repository then leaves an existing meeting where it is.
   */
  directoryOf(id: string | null): Promise<string | null>;
}

/** Port: the context files of the projects. Adapter: createProjectFileStore (platform/projects). */
export interface ProjectFileStore {
  list(projectId: string): Promise<readonly ProjectFile[]>;
  countByProject(): Promise<ReadonlyMap<string, number>>;
  /** Validates, hashes, extracts the text and copies the file into project storage. */
  add(projectId: string, sourcePath: string): Promise<AddProjectFileResult>;
  remove(projectId: string, fileId: string): Promise<boolean>;
  /** The extracted text of every file, ordered by `addedAt`, for the context packer. */
  readDocuments(projectId: string): Promise<readonly AttachedDocument[]>;
}

/** What a consumer needs to put a project in front of a model. */
export interface ProjectContextData {
  readonly projectId: string;
  readonly name: string;
  readonly instructions: string;
  readonly documents: readonly AttachedDocument[];
}

/** Port: the project's instructions and files, for chat, the Live copilot and summaries. */
export interface ProjectContextSource {
  /** Null for an unknown project. */
  get(projectId: string): Promise<ProjectContextData | null>;
}

/** What the meeting repository needs from the projects: where a meeting is saved. */
export type MeetingPlacement = Pick<ProjectRepository, 'directoryOf'>;
