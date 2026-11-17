/** The limits of a project, shared by the service, the stores and the zod mirrors in contracts. */
export const PROJECT_NAME_MAX = 120;
export const PROJECT_DESCRIPTION_MAX = 500;
export const PROJECT_INSTRUCTIONS_MAX = 20_000;
/** Deepest folder chain the migration follows before it makes a folder a root. */
export const MAX_CHAIN_DEPTH = 32;

/**
 * A flat container of meetings with instructions and context files. No colors, no icons and no
 * parent: a project is never nested.
 */
export interface Project {
  /** Canonical lowercase GUID. A project migrated from a folder keeps the folder's id. */
  readonly id: string;
  /** 1..120 characters, unique by folded text (case and accents do not count). */
  readonly name: string;
  /** 0..500 characters, shown on the card and the page header. */
  readonly description: string;
  /** 0..20,000 characters. The former folder note for a migrated project. */
  readonly instructions: string;
  readonly pinned: boolean;
  /** ISO-8601 UTC, e.g. `2026-11-16T14:03:00.000Z`. */
  readonly createdAt: string;
  /** Metadata edits only (name, description, instructions, pin). */
  readonly updatedAt: string;
}

/** What the grid needs: no instructions text, plus the counts and the activity date. */
export type ProjectListItem = Omit<Project, 'instructions'> & {
  readonly meetingCount: number;
  readonly fileCount: number;
  /** The newest of the project's own edit, its meetings and its chats. ISO-8601 UTC. */
  readonly lastActivityAt: string;
};

/** The meetings that belong to no project (the former Inbox). */
export interface NoProjectSummary {
  readonly meetingCount: number;
  readonly lastActivityAt: string | null;
}

export interface ProjectsOverview {
  readonly projects: readonly ProjectListItem[];
  readonly noProject: NoProjectSummary;
}

export interface NewProject {
  readonly name: string;
  readonly description?: string;
}

export interface ProjectPatch {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly pinned?: boolean;
}

/** Why a project on disk is listed but unusable. Its directory and name stay reserved. */
export interface SkippedProject {
  /** Null when the id could not be read. */
  readonly id: string | null;
  /** The frozen directory when it could be read. */
  readonly dir: string | null;
  readonly reason: 'corrupt' | 'unsupported' | 'unsafe-dir';
}
