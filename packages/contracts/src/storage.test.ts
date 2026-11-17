import { describe, expect, it } from 'vitest';
import {
  STORAGE_KIND_VERSIONS,
  chatThreadFileSchema,
  extractedTextSchema,
  libraryManifestSchema,
  projectDirSchema,
  projectFileMetaSchema,
  projectRecordSchema,
} from './index';

const ID = '9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b';
const FILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AT = '2026-11-16T14:03:00.000Z';

const manifest = {
  schemaVersion: 1,
  createdAt: AT,
  migrations: [
    {
      id: '001-folders-to-projects',
      appliedAt: AT,
      report: {
        source: 'library',
        projects: 7,
        renamed: [{ id: ID, from: 'Cálculo', to: 'Universidad – Cálculo' }],
        skipped: [],
        legacyLeftovers: [],
        backup: 'backups/folders.v0.20261116T140300Z.json',
        backupSha256: 'abc',
      },
    },
  ],
  pendingNotice: { kind: 'folders-to-projects', projects: 7, renamed: 1, skipped: 0, leftovers: 0 },
};
const projectRecord = {
  schemaVersion: 1,
  id: ID,
  name: 'Universidad – Cálculo',
  description: '',
  instructions: 'Resumir en español',
  pinned: false,
  dir: 'Universidad/Cálculo',
  createdAt: AT,
  updatedAt: AT,
  origin: { kind: 'folder', parentId: null, originalName: 'Cálculo' },
};
const fileMeta = {
  schemaVersion: 1,
  id: FILE,
  name: 'Syllabus.pdf',
  kind: 'pdf',
  sizeBytes: 10,
  pages: 2,
  truncated: false,
  textChars: 100,
  sha256: 'abc',
  addedAt: AT,
};
const extracted = {
  schemaVersion: 1,
  pages: 2,
  truncated: false,
  sections: [
    { location: { kind: 'page', n: 1 }, text: 'one' },
    { location: null, text: 'two' },
  ],
};
const thread = {
  schemaVersion: 1,
  id: FILE,
  ownerProjectId: ID,
  scope: { kind: 'Project', meetingId: null },
  title: 'Exam dates',
  createdAt: AT,
  updatedAt: AT,
  messages: [{ id: 'm1', role: 'user', text: 'When?', createdAt: AT }],
};

const kinds = [
  ['manifest', libraryManifestSchema, manifest],
  ['project', projectRecordSchema, projectRecord],
  ['file meta', projectFileMetaSchema, fileMeta],
  ['extracted text', extractedTextSchema, extracted],
  ['thread', chatThreadFileSchema, thread],
] as const;

describe('storage formats', () => {
  it.each(kinds)('round trips a %s', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each(kinds)('keeps unknown keys on a %s, at the top and nested', (_name, schema, value) => {
    const extra = { ...value, futureField: { keep: true } };
    expect(schema.parse(extra)).toEqual(extra);
  });

  it.each(kinds)('refuses a %s with a version it does not know', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: undefined }).success).toBe(false);
  });

  it('keeps unknown keys inside a project origin and a manifest log entry', () => {
    const origin = { ...projectRecord.origin, extra: 1 };
    expect(projectRecordSchema.parse({ ...projectRecord, origin }).origin).toEqual(origin);
    const entry = { ...manifest.migrations[0], extra: 1 };
    expect(libraryManifestSchema.parse({ ...manifest, migrations: [entry] }).migrations[0]).toEqual(
      entry,
    );
  });

  it('lowercases every id on parse', () => {
    expect(projectRecordSchema.parse({ ...projectRecord, id: ID.toUpperCase() }).id).toBe(ID);
    expect(projectFileMetaSchema.parse({ ...fileMeta, id: FILE.toUpperCase() }).id).toBe(FILE);
    const parsed = chatThreadFileSchema.parse({
      ...thread,
      id: FILE.toUpperCase(),
      ownerProjectId: ID.toUpperCase(),
    });
    expect(parsed.id).toBe(FILE);
    expect(parsed.ownerProjectId).toBe(ID);
  });

  it('refuses an id that is not a GUID', () => {
    expect(projectRecordSchema.safeParse({ ...projectRecord, id: '../x' }).success).toBe(false);
    expect(chatThreadFileSchema.safeParse({ ...thread, id: 'abc' }).success).toBe(false);
    expect(chatThreadFileSchema.safeParse({ ...thread, ownerProjectId: 'no' }).success).toBe(false);
  });

  it('a thread of no project has a null owner', () => {
    expect(
      chatThreadFileSchema.parse({ ...thread, ownerProjectId: null }).ownerProjectId,
    ).toBeNull();
  });

  it('a fresh install manifest has no log, no notice and no backup', () => {
    const fresh = { schemaVersion: 1, createdAt: AT, migrations: [] };
    expect(libraryManifestSchema.parse(fresh)).toEqual(fresh);
    const noSource = {
      id: '001-folders-to-projects',
      appliedAt: AT,
      report: {
        source: 'none',
        projects: 0,
        renamed: [],
        skipped: [],
        legacyLeftovers: [],
        backup: null,
        backupSha256: null,
      },
    };
    expect(
      libraryManifestSchema.safeParse({ ...fresh, migrations: [noSource], pendingNotice: null })
        .success,
    ).toBe(true);
  });
});

describe('projectDirSchema', () => {
  it('accepts relative directories made of plain segments', () => {
    for (const dir of ['Work', 'Universidad/Cálculo', 'Team a/b/c', 'v1.2 notes']) {
      expect(projectDirSchema.safeParse(dir).success).toBe(true);
    }
  });

  it('rejects an unsafe directory', () => {
    const unsafe = [
      '',
      '/abs',
      '\\server\\share',
      'C:\\Users\\x',
      'C:/Users/x',
      'a:b',
      'a\\b',
      'a/',
      '/',
      'a//b',
      '.',
      '..',
      '../x',
      'a/../b',
      'a/./b',
      '.vozella',
      '.vozella/projects',
      'ok/.hidden',
      'x'.repeat(261),
    ];
    for (const dir of unsafe) {
      expect(projectDirSchema.safeParse(dir).success, dir).toBe(false);
    }
    expect(projectRecordSchema.safeParse({ ...projectRecord, dir: '../escape' }).success).toBe(
      false,
    );
    expect(projectRecordSchema.safeParse({ ...projectRecord, dir: '.vozella' }).success).toBe(
      false,
    );
  });

  it('accepts exactly 260 characters', () => {
    expect(projectDirSchema.safeParse('x'.repeat(260)).success).toBe(true);
  });
});

describe('STORAGE_KIND_VERSIONS', () => {
  it('names every persisted kind at the version its schema accepts', () => {
    expect(Object.keys(STORAGE_KIND_VERSIONS).sort()).toEqual([
      'extractedText',
      'fileMeta',
      'manifest',
      'project',
      'thread',
    ]);
    for (const [, schema, value] of kinds) {
      expect(schema.safeParse({ ...value, schemaVersion: 1 }).success).toBe(true);
    }
  });
});
