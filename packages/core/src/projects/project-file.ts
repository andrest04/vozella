import type { DocumentKind } from '../chat/attachments';

/** A project holds at most this many context files. */
export const PROJECT_FILE_MAX_FILES = 25;
/** Their extracted text together never exceeds this, so one retrieval scores a bounded corpus. */
export const PROJECT_FILES_MAX_TOTAL_CHARS = 1_000_000;

/** A context file owned by a project: copied into project storage, its text extracted once. */
export interface ProjectFile {
  readonly id: string;
  /** The original file name. */
  readonly name: string;
  /** Images are not supported in a project. */
  readonly kind: DocumentKind;
  readonly sizeBytes: number;
  /** Pages of a PDF or slides of a presentation; null otherwise. */
  readonly pages: number | null;
  /** The extracted text was cut at `ATTACHMENT_MAX_CHARS`. */
  readonly truncated: boolean;
  readonly textChars: number;
  /** Duplicate detection: the same bytes under another name are refused. */
  readonly sha256: string;
  readonly addedAt: string;
}

export type ProjectFileFailure =
  | 'not-found'
  | 'unsupported'
  | 'too-large'
  | 'encrypted'
  | 'no-text'
  | 'unreadable'
  | 'duplicate'
  | 'project-full'
  | 'not-a-project'
  | 'storage-migrating'
  | 'storage-error'
  | 'storage-newer';

/** One result per file: a bad file never stops the others. */
export type AddProjectFileResult =
  | { readonly ok: true; readonly file: ProjectFile }
  | { readonly ok: false; readonly name: string; readonly reason: ProjectFileFailure };
