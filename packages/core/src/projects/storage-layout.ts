import type { PathJoiner } from '../library/app-paths';

/** The directory, inside the Library root, that holds everything the app owns. */
export const META_DIR_NAME = '.vozella';
/** Meetings that belong to no project. */
export const INBOX_DIR_NAME = 'Inbox';
/**
 * The version of the library storage as a whole. Bumping it needs one entry in the ordered
 * migrations registry (platform) in the same commit; a per-kind `schemaVersion` may never exceed it.
 */
export const STORAGE_SCHEMA_VERSION = 1;

/** The directory name of the chats that belong to no project. */
const NO_PROJECT_DIR_NAME = 'no-project';

const CANONICAL_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Throws unless `id` is a canonical lowercase GUID, so a path is never built from other text. */
export function assertCanonicalGuid(id: string, what: string): void {
  if (!CANONICAL_GUID.test(id)) {
    throw new Error(`${what} must be a canonical lowercase GUID.`);
  }
}

/** Where every stored file of a library lives. Pure: the caller supplies the path operation. */
export interface StorageLayout {
  readonly metaDirectory: string;
  readonly manifestFile: string;
  readonly backupsDirectory: string;
  readonly projectsDirectory: string;
  readonly inboxDirectory: string;
  projectDirectory(projectId: string): string;
  projectJsonFile(projectId: string): string;
  filesDirectory(projectId: string): string;
  fileDirectory(projectId: string, fileId: string): string;
  /** The chats of a project; `null` is the chats that belong to no project. */
  chatsDirectory(owner: string | null): string;
  threadFile(owner: string | null, threadId: string): string;
}

/**
 * Every id argument is asserted to be a canonical lowercase GUID (it throws otherwise), so a
 * layout function can never build a path from untrusted text.
 */
export function createStorageLayout(libraryRoot: string, path: PathJoiner): StorageLayout {
  const meta = path.join(libraryRoot, META_DIR_NAME);
  const projects = path.join(meta, 'projects');
  const projectDirectory = (projectId: string): string => {
    assertCanonicalGuid(projectId, 'A project id');
    return path.join(projects, projectId);
  };
  const chatsDirectory = (owner: string | null): string =>
    owner === null
      ? path.join(meta, NO_PROJECT_DIR_NAME, 'chats')
      : path.join(projectDirectory(owner), 'chats');
  return {
    metaDirectory: meta,
    manifestFile: path.join(meta, 'library.json'),
    backupsDirectory: path.join(meta, 'backups'),
    projectsDirectory: projects,
    inboxDirectory: path.join(libraryRoot, INBOX_DIR_NAME),
    projectDirectory,
    projectJsonFile: (projectId) => path.join(projectDirectory(projectId), 'project.json'),
    filesDirectory: (projectId) => path.join(projectDirectory(projectId), 'files'),
    fileDirectory: (projectId, fileId) => {
      assertCanonicalGuid(fileId, 'A file id');
      return path.join(projectDirectory(projectId), 'files', fileId);
    },
    chatsDirectory,
    threadFile: (owner, threadId) => {
      assertCanonicalGuid(threadId, 'A thread id');
      return path.join(chatsDirectory(owner), `${threadId}.json`);
    },
  };
}
