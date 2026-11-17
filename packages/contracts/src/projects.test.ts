import { describe, expect, it } from 'vitest';
import {
  eventChannels,
  projectDeleteResultSchema,
  projectsChanged,
  projectsCreate,
  projectsDelete,
  projectsDismissMigrationReport,
  projectsFilesAdd,
  projectsFilesPick,
  projectsFilesRemove,
  projectsGet,
  projectsList,
  projectsMigrationReport,
  projectsSetInstructions,
  projectsUpdate,
  requestChannels,
  storageStateSchema,
} from './index';

const ID = '9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b';
const FILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const project = {
  id: ID,
  name: 'Calculus',
  description: '',
  instructions: 'Be brief.',
  pinned: false,
  createdAt: '2026-11-16T14:03:00.000Z',
  updatedAt: '2026-11-16T14:03:00.000Z',
};
const file = {
  id: FILE,
  name: 'Syllabus.pdf',
  kind: 'pdf',
  sizeBytes: 1200,
  pages: 12,
  truncated: false,
  textChars: 5000,
  sha256: 'abc',
  addedAt: '2026-11-16T14:03:00.000Z',
};

describe('project contracts', () => {
  it('registers every project request and event by name', () => {
    for (const name of [
      'projects.list',
      'projects.get',
      'projects.create',
      'projects.update',
      'projects.setInstructions',
      'projects.delete',
      'projects.files.pick',
      'projects.files.add',
      'projects.files.remove',
      'projects.migrationReport',
      'projects.dismissMigrationReport',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
    expect(Object.keys(eventChannels)).toContain('projects.changed');
  });

  it('round trips projects.list with the no-project summary and the storage state', () => {
    const output = {
      projects: [
        {
          id: ID,
          name: 'Calculus',
          description: '',
          pinned: true,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          meetingCount: 9,
          fileCount: 2,
          lastActivityAt: project.updatedAt,
        },
      ],
      noProject: { meetingCount: 3, lastActivityAt: null },
      skipped: [{ id: null, dir: 'Old', reason: 'corrupt' }],
      storage: { status: 'ready' },
    };
    expect(projectsList.output.parse(output)).toEqual(output);
    expect(projectsList.input.safeParse({}).success).toBe(true);
    expect(projectsList.input.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('a list item never carries the instructions', () => {
    const item = { ...project, meetingCount: 0, fileCount: 0, lastActivityAt: project.updatedAt };
    const parsed = projectsList.output.parse({
      projects: [item],
      noProject: { meetingCount: 0, lastActivityAt: null },
      skipped: [],
      storage: { status: 'ready' },
    });
    expect(parsed.projects[0]).not.toHaveProperty('instructions');
  });

  it('describes every storage state', () => {
    for (const state of [
      { status: 'migrating' },
      { status: 'ready' },
      { status: 'error', message: 'x' },
      { status: 'newer', found: 2, supported: 1 },
    ]) {
      expect(storageStateSchema.parse(state)).toEqual(state);
    }
    expect(storageStateSchema.safeParse({ status: 'newer' }).success).toBe(false);
    expect(storageStateSchema.safeParse({ status: 'broken' }).success).toBe(false);
  });

  it('answers get with the project and its files, or a failure as a value', () => {
    expect(projectsGet.output.parse({ ok: true, project, files: [file] })).toEqual({
      ok: true,
      project,
      files: [file],
    });
    expect(projectsGet.output.safeParse({ ok: false, reason: 'not-found' }).success).toBe(true);
    expect(projectsGet.output.safeParse({ ok: false, reason: 'made-up' }).success).toBe(false);
  });

  it('lowercases an id and refuses anything that is not a GUID', () => {
    expect(projectsGet.input.parse({ id: ID.toUpperCase() })).toEqual({ id: ID });
    expect(projectsDelete.input.parse({ id: ID.toUpperCase() })).toEqual({ id: ID });
    for (const id of ['', 'abc', '../x', ID.replaceAll('-', ''), `${ID}/..`, `{${ID}}`, 'a\\b']) {
      expect(projectsGet.input.safeParse({ id }).success).toBe(false);
      expect(projectsUpdate.input.safeParse({ id, pinned: true }).success).toBe(false);
      expect(projectsFilesRemove.input.safeParse({ projectId: id, fileId: FILE }).success).toBe(
        false,
      );
    }
    expect(projectsFilesRemove.input.safeParse({ projectId: ID, fileId: '../x' }).success).toBe(
      false,
    );
  });

  it('create and update take only the fields they name', () => {
    expect(projectsCreate.input.safeParse({ name: 'Work' }).success).toBe(true);
    expect(projectsCreate.input.safeParse({ name: 'Work', description: 'd' }).success).toBe(true);
    expect(projectsCreate.input.safeParse({}).success).toBe(false);
    expect(projectsCreate.input.safeParse({ name: 'Work', color: 'red' }).success).toBe(false);
    expect(projectsUpdate.input.safeParse({ id: ID }).success).toBe(true);
    expect(projectsUpdate.input.safeParse({ id: ID, name: 'N', pinned: true }).success).toBe(true);
    expect(projectsUpdate.input.safeParse({ id: ID, parentId: null }).success).toBe(false);
  });

  it('limits the instructions to 20,000 characters', () => {
    const input = (instructions: string) => ({ id: ID, instructions });
    expect(projectsSetInstructions.input.safeParse(input('a'.repeat(20_000))).success).toBe(true);
    expect(projectsSetInstructions.input.safeParse(input('a'.repeat(20_001))).success).toBe(false);
  });

  it('delete answers done, a failure, or partial with counts', () => {
    expect(projectDeleteResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(projectDeleteResultSchema.parse({ ok: false, reason: 'busy' })).toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(projectDeleteResultSchema.parse({ ok: false, reason: 'storage-newer' })).toMatchObject({
      reason: 'storage-newer',
    });
    expect(
      projectDeleteResultSchema.parse({ ok: false, reason: 'partial', moved: 9, remaining: 3 }),
    ).toEqual({ ok: false, reason: 'partial', moved: 9, remaining: 3 });
    expect(projectDeleteResultSchema.safeParse({ ok: false, reason: 'partial' }).success).toBe(
      false,
    );
    expect(projectDeleteResultSchema.safeParse({ ok: false, reason: 'made-up' }).success).toBe(
      false,
    );
  });

  it('files.add takes one to ten paths; pick takes only the project', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `C:\\f\\${String(i)}.txt`);
    expect(projectsFilesAdd.input.safeParse({ projectId: ID, paths: paths(1) }).success).toBe(true);
    expect(projectsFilesAdd.input.safeParse({ projectId: ID, paths: paths(10) }).success).toBe(
      true,
    );
    expect(projectsFilesAdd.input.safeParse({ projectId: ID, paths: paths(11) }).success).toBe(
      false,
    );
    expect(projectsFilesAdd.input.safeParse({ projectId: ID, paths: [] }).success).toBe(false);
    expect(projectsFilesPick.input.safeParse({ projectId: ID }).success).toBe(true);
    expect(projectsFilesPick.input.safeParse({ projectId: ID, paths: [] }).success).toBe(false);
  });

  it('files results carry one outcome per file, success or a reason', () => {
    const results = [
      { ok: true, file },
      { ok: false, name: 'a.png', reason: 'unsupported' },
      { ok: false, name: 'b.pdf', reason: 'storage-migrating' },
    ];
    expect(projectsFilesPick.output.parse({ results })).toEqual({ results });
    expect(
      projectsFilesAdd.output.safeParse({ results: [{ ok: false, name: 'x', reason: 'nope' }] })
        .success,
    ).toBe(false);
    expect(projectsFilesRemove.output.parse({ removed: true })).toEqual({ removed: true });
  });

  it('the migration report is null or the one-time notice', () => {
    expect(projectsMigrationReport.output.parse({ report: null })).toEqual({ report: null });
    const report = {
      kind: 'folders-to-projects',
      projects: 7,
      renamed: [{ id: ID, from: 'Cálculo', to: 'Universidad – Cálculo' }],
      skipped: [{ index: 3, reason: 'invalid-id' }],
      legacyLeftovers: ['meetings-folder'],
    };
    expect(projectsMigrationReport.output.parse({ report })).toEqual({ report });
    expect(projectsDismissMigrationReport.output.parse({})).toEqual({});
  });

  it('projects.changed says what changed and for which project', () => {
    expect(projectsChanged.payload.parse({ reason: 'files', projectId: ID.toUpperCase() })).toEqual(
      {
        reason: 'files',
        projectId: ID,
      },
    );
    expect(projectsChanged.payload.safeParse({ reason: 'project', projectId: null }).success).toBe(
      true,
    );
    expect(projectsChanged.payload.safeParse({ reason: 'folder', projectId: null }).success).toBe(
      false,
    );
  });
});
