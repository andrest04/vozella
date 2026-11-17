import { z } from 'zod';
import { guidSchema, projectIdSchema } from './ids';
import { projectFileKindSchema } from './projects';

/**
 * Persisted formats of the library storage (`<Library>/.vozella`), validated by the platform
 * adapters. Plain UTF-8 JSON with an explicit `schemaVersion`.
 *
 * One version rule: the manifest `schemaVersion` is the only version that gates opening a
 * library. A per-kind version below is a discriminator for in-memory upgrade and may never be
 * bumped without bumping the manifest and adding a migration in the same commit.
 *
 * Every schema is a loose object: unknown keys are carried through a read-modify-write, so a newer
 * writer's fields survive an older one. To add a version, make the kind a union of the old and
 * the new literal with an upgrade function.
 */

/** The current version of each persisted kind. None may exceed `STORAGE_SCHEMA_VERSION` of core. */
export const STORAGE_KIND_VERSIONS = {
  manifest: 1,
  project: 1,
  fileMeta: 1,
  extractedText: 1,
  thread: 1,
} as const;

const iso = z.string().min(1);

/**
 * The directory of a project relative to the Library root, frozen when the project is created.
 * Rejected at parse time: empty, absolute, a drive letter or colon, a backslash, a leading or
 * trailing slash, an empty segment, a `.` or `..` segment, a segment that starts with a dot
 * (so the metadata directory is impossible) and more than 260 characters. Core's
 * `isSafeProjectDir` rejects more (device names, trailing dots) and stays authoritative.
 */
export const projectDirSchema = z
  .string()
  .min(1)
  .max(260)
  .refine((dir) => !/[:\\]/.test(dir), 'No drive letter, colon or backslash')
  .refine(
    (dir) => !dir.startsWith('/') && !dir.endsWith('/'),
    'Relative, no leading or trailing slash',
  )
  .refine(
    (dir) => dir.split('/').every((segment) => segment !== '' && !segment.startsWith('.')),
    'No empty segment and no segment that starts with a dot',
  );

const migrationReportRecord = z.looseObject({
  /** Where the old folder list was found: `library`, `app-data` or `none` (a fresh install). */
  source: z.string(),
  projects: z.number().int().nonnegative(),
  renamed: z.array(z.looseObject({ id: projectIdSchema, from: z.string(), to: z.string() })),
  skipped: z.array(z.looseObject({ index: z.number().int().nonnegative(), reason: z.string() })),
  legacyLeftovers: z.array(z.string()),
  /** Path of the backup relative to `.vozella`; null when there was no source. */
  backup: z.string().nullable(),
  backupSha256: z.string().nullable(),
  ignoredSource: z.string().optional(),
});

export const libraryManifestSchema = z.looseObject({
  schemaVersion: z.literal(1),
  createdAt: iso,
  migrations: z.array(
    z.looseObject({
      id: z.string().min(1),
      appliedAt: iso,
      report: migrationReportRecord.optional(),
    }),
  ),
  /** The one-time notice; cleared when the user dismisses it. */
  pendingNotice: z
    .looseObject({
      kind: z.literal('folders-to-projects'),
      projects: z.number().int().nonnegative(),
      renamed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      leftovers: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type LibraryManifestRecord = z.infer<typeof libraryManifestSchema>;

/** `.vozella/projects/<id>/project.json` */
export const projectRecordSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: projectIdSchema,
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string(),
  pinned: z.boolean(),
  dir: projectDirSchema,
  createdAt: iso,
  updatedAt: iso,
  /** Set for projects that came from the old folder list. */
  origin: z
    .looseObject({
      kind: z.literal('folder'),
      parentId: z.string().nullable(),
      originalName: z.string(),
    })
    .optional(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

/** `.vozella/projects/<id>/files/<fileId>/meta.json`, written last. */
export const projectFileMetaSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: guidSchema,
  name: z.string().min(1),
  kind: projectFileKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  textChars: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  addedAt: iso,
});
export type ProjectFileMetaRecord = z.infer<typeof projectFileMetaSchema>;

/** `.vozella/projects/<id>/files/<fileId>/extracted.json` */
export const extractedTextSchema = z.looseObject({
  schemaVersion: z.literal(1),
  pages: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  sections: z.array(
    z.looseObject({
      /** Where the text sits: a page, a slide or nowhere (plain text). */
      location: z
        .looseObject({ kind: z.enum(['page', 'slide']), n: z.number().int().positive() })
        .nullable(),
      text: z.string(),
    }),
  ),
});
export type ExtractedTextRecord = z.infer<typeof extractedTextSchema>;

const chatMessageRecord = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: iso,
});

/** `.vozella/projects/<id>/chats/<threadId>.json` and `.vozella/no-project/chats/...` */
export const chatThreadFileSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: guidSchema,
  /** The project that owns the thread; null is "no project". */
  ownerProjectId: projectIdSchema.nullable(),
  scope: z.looseObject({
    kind: z.enum(['AllMeetings', 'Project', 'Meeting', 'Live']),
    meetingId: z.string().nullable(),
  }),
  title: z.string(),
  createdAt: iso,
  updatedAt: iso,
  messages: z.array(chatMessageRecord),
});
export type ChatThreadFileRecord = z.infer<typeof chatThreadFileSchema>;
