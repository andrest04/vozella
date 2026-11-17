import { z } from 'zod';
import { defineEvent, defineRequest } from './channel';
import { guidSchema, projectIdSchema } from './ids';

/**
 * Project channels (module: projects). A project is a flat container of meetings with
 * instructions and context files. Every answer is a value, never a thrown error. Every id in an
 * input is a canonical lowercase GUID, so a request cannot name a path.
 */

const empty = z.object({}).strict();

/** The same limits as core `projects/project.ts`. */
export const PROJECT_NAME_MAX = 120;
export const PROJECT_DESCRIPTION_MAX = 500;
export const PROJECT_INSTRUCTIONS_MAX = 20_000;
export const PROJECT_FILES_PICK_MAX = 10;

export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1).max(PROJECT_NAME_MAX),
  description: z.string().max(PROJECT_DESCRIPTION_MAX),
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX),
  pinned: z.boolean(),
  /** ISO-8601 UTC. */
  createdAt: z.string(),
  /** Metadata edits only (name, description, instructions, pin). */
  updatedAt: z.string(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

export const projectListItemSchema = projectSchema.omit({ instructions: true }).extend({
  meetingCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  /** ISO-8601 UTC: the newest of the project's own edits, its meetings and its chats. */
  lastActivityAt: z.string(),
});
export type ProjectListItemDto = z.infer<typeof projectListItemSchema>;

export const projectFileKindSchema = z.enum(['pdf', 'docx', 'pptx', 'text']);

export const projectFileSchema = z.object({
  id: guidSchema,
  /** The original file name. */
  name: z.string().min(1).max(400),
  kind: projectFileKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  /** Pages of a PDF or slides of a presentation; null otherwise. */
  pages: z.number().int().nonnegative().nullable(),
  /** The extracted text was cut at the attachment limit. */
  truncated: z.boolean(),
  textChars: z.number().int().nonnegative(),
  sha256: z.string(),
  addedAt: z.string(),
});
export type ProjectFileDto = z.infer<typeof projectFileSchema>;

export const storageStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('migrating') }),
  z.object({ status: z.literal('ready') }),
  z.object({ status: z.literal('error'), message: z.string() }),
  z.object({
    status: z.literal('newer'),
    found: z.number().int(),
    supported: z.number().int(),
  }),
]);
export type StorageStateDto = z.infer<typeof storageStateSchema>;

export const projectFailureReasonSchema = z.enum([
  'empty-name',
  'name-taken',
  'too-long',
  'not-found',
  'busy',
  'corrupt',
  'io-failed',
  'trash-failed',
  'storage-migrating',
  'storage-error',
  'storage-newer',
]);
export type ProjectFailureReasonDto = z.infer<typeof projectFailureReasonSchema>;

const failureShape = {
  ok: z.literal(false),
  reason: projectFailureReasonSchema,
  /** Error text for `io-failed` and `corrupt`; show it after a localized lead-in. */
  message: z.string().optional(),
};

const projectResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), project: projectSchema }),
  z.object(failureShape),
]);

export const skippedProjectSchema = z.object({
  /** Null when the id could not be read. */
  id: z.string().nullable(),
  /** The frozen directory, when it could be read. */
  dir: z.string().nullable(),
  reason: z.enum(['corrupt', 'unsupported', 'unsafe-dir']),
});
export type SkippedProjectDto = z.infer<typeof skippedProjectSchema>;

export const projectFileFailureSchema = z.enum([
  'not-found',
  'unsupported',
  'too-large',
  'encrypted',
  'no-text',
  'unreadable',
  'duplicate',
  'project-full',
  'not-a-project',
  'storage-migrating',
  'storage-error',
  'storage-newer',
]);
export type ProjectFileFailureDto = z.infer<typeof projectFileFailureSchema>;

/** One result per file: a bad file never stops the others. */
export const addProjectFileResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), file: projectFileSchema }),
  z.object({
    ok: z.literal(false),
    /** The file name the user picked, for the message. */
    name: z.string(),
    reason: projectFileFailureSchema,
  }),
]);
export type AddProjectFileResultDto = z.infer<typeof addProjectFileResultSchema>;

/** Done, refused, or stopped half way: counts let the page say "Moved 9 of 12 meetings". */
export const projectDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object(failureShape),
  z.object({
    ok: z.literal(false),
    reason: z.literal('partial'),
    moved: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
]);
export type ProjectDeleteResultDto = z.infer<typeof projectDeleteResultSchema>;

export const migrationReportSchema = z.object({
  kind: z.literal('folders-to-projects'),
  /** How many projects the old folder list became. */
  projects: z.number().int().nonnegative(),
  renamed: z.array(z.object({ id: projectIdSchema, from: z.string(), to: z.string() })).readonly(),
  skipped: z
    .array(z.object({ index: z.number().int().nonnegative(), reason: z.string() }))
    .readonly(),
  /** Older layouts that were found and not imported; named in words by the page. */
  legacyLeftovers: z.array(z.string()).readonly(),
});
export type MigrationReportDto = z.infer<typeof migrationReportSchema>;

export const projectsList = defineRequest('projects.list', {
  input: empty,
  output: z.object({
    projects: z.array(projectListItemSchema).readonly(),
    noProject: z.object({
      meetingCount: z.number().int().nonnegative(),
      lastActivityAt: z.string().nullable(),
    }),
    skipped: z.array(skippedProjectSchema).readonly(),
    storage: storageStateSchema,
  }),
});

export const projectsGet = defineRequest('projects.get', {
  input: z.object({ id: projectIdSchema }).strict(),
  output: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      project: projectSchema,
      files: z.array(projectFileSchema).readonly(),
    }),
    z.object(failureShape),
  ]),
});

export const projectsCreate = defineRequest('projects.create', {
  /** The service answers `too-long`; the schema only guards against absurd input. */
  input: z
    .object({ name: z.string().max(1_000), description: z.string().max(5_000).optional() })
    .strict(),
  output: projectResult,
});

export const projectsUpdate = defineRequest('projects.update', {
  input: z
    .object({
      id: projectIdSchema,
      name: z.string().max(1_000).optional(),
      description: z.string().max(5_000).optional(),
      pinned: z.boolean().optional(),
    })
    .strict(),
  output: projectResult,
});

export const projectsSetInstructions = defineRequest('projects.setInstructions', {
  input: z
    .object({ id: projectIdSchema, instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX) })
    .strict(),
  output: projectResult,
});

export const projectsDelete = defineRequest('projects.delete', {
  input: z.object({ id: projectIdSchema }).strict(),
  output: projectDeleteResultSchema,
});

const fileResults = z.object({ results: z.array(addProjectFileResultSchema).readonly() });

/** Opens the file picker in main. An empty list means the user cancelled. */
export const projectsFilesPick = defineRequest('projects.files.pick', {
  input: z.object({ projectId: projectIdSchema }).strict(),
  output: fileResults,
});

/** Paths from a drop; main validates each one again. */
export const projectsFilesAdd = defineRequest('projects.files.add', {
  input: z
    .object({
      projectId: projectIdSchema,
      paths: z.array(z.string().min(1).max(4_096)).min(1).max(PROJECT_FILES_PICK_MAX),
    })
    .strict(),
  output: fileResults,
});

export const projectsFilesRemove = defineRequest('projects.files.remove', {
  input: z.object({ projectId: projectIdSchema, fileId: guidSchema }).strict(),
  output: z.object({ removed: z.boolean() }),
});

/** The one-time notice about the folder to project migration, or null when there is none. */
export const projectsMigrationReport = defineRequest('projects.migrationReport', {
  input: empty,
  output: z.object({ report: migrationReportSchema.nullable() }),
});

export const projectsDismissMigrationReport = defineRequest('projects.dismissMigrationReport', {
  input: empty,
  output: empty,
});

export const projectsChanged = defineEvent('projects.changed', {
  payload: z.object({
    reason: z.enum(['project', 'files']),
    projectId: projectIdSchema.nullable(),
  }),
});
