import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_KIND_VERSIONS } from '@vozella/contracts';
import { createStorageLayout, type Clock } from '@vozella/core';
import {
  createProjectsFixture,
  silentLogger,
  tree,
  type ProjectsFixture,
} from '../project-repository-test-kit';
import type { MigrationContext } from '../storage-migrator';

export { tree };
export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

export const F = {
  universidad: '1b7e0000-0000-4000-8000-000000000001',
  calculoU: '1b7e0000-0000-4000-8000-000000000002',
  derivadas: '1b7e0000-0000-4000-8000-000000000003',
  trabajo: '1b7e0000-0000-4000-8000-000000000004',
  calculoT: '1b7e0000-0000-4000-8000-000000000005',
  huerfana: '1b7e0000-0000-4000-8000-000000000006',
  conNota: '1b7e0000-0000-4000-8000-000000000007',
} as const;

/**
 * A hand-written old folder list: a byte order mark, CRLF, mixed key case, three levels of
 * nesting, two folders named Cálculo, an orphan whose parent is gone and a folder with a note.
 */
export function legacyFoldersText(): string {
  const entries = [
    {
      Id: F.universidad.toUpperCase(),
      Name: 'Universidad',
      ParentId: null,
      Note: null,
      ColorKey: 'blue',
      IconKey: null,
      CreatedAt: '2025-03-01T10:00:00.0000000-05:00',
    },
    {
      id: F.calculoU,
      name: 'Cálculo',
      parentId: F.universidad,
      note: null,
      colorKey: 'red',
      iconKey: 'book',
      createdAt: '2025-03-02T10:00:00-05:00',
    },
    {
      ID: F.derivadas,
      NAME: 'Derivadas',
      PARENTID: F.calculoU,
      NOTE: 'Resumir en español',
      createdAT: '2025-03-03T10:00:00.5-05:00',
    },
    {
      id: F.trabajo,
      name: 'Trabajo',
      parentId: null,
      note: null,
      createdAt: '2025-03-04T10:00:00-05:00',
    },
    {
      id: F.calculoT,
      name: 'cálculo',
      parentId: F.trabajo,
      note: null,
      createdAt: '2025-03-05T10:00:00-05:00',
    },
    {
      id: F.huerfana,
      name: 'Huérfana',
      parentId: '1b7e0000-0000-4000-8000-0000000000ff',
      note: null,
      createdAt: '2025-03-06T10:00:00-05:00',
    },
    {
      id: F.conNota,
      name: 'Producto Q4',
      parentId: null,
      note: 'Usar tono formal',
      createdAt: '2025-03-07T10:00:00-05:00',
    },
  ];
  return `\uFEFF${JSON.stringify(entries, null, 2).replace(/\n/g, '\r\n')}`;
}

export interface MigrationFixture extends ProjectsFixture {
  readonly context: MigrationContext;
  readonly clock: Clock;
  readonly foldersInLibrary: string;
  readonly foldersInAppData: string;
  /** Writes `rel` (with `/` separators) under the Library root. */
  put(rel: string, content?: string): string;
}

export function createMigrationFixture(): MigrationFixture {
  const fx = createProjectsFixture({ state: { status: 'migrating' } });
  const clock: Clock = { now: () => new Date('2026-11-16T14:03:00.000Z') };
  const context: MigrationContext = {
    libraryRoot: fx.root,
    appDataRoot: fx.appData,
    layout: createStorageLayout(fx.root, path),
    logger: silentLogger,
    clock,
  };
  return {
    ...fx,
    context,
    clock,
    foldersInLibrary: path.join(fx.root, 'folders.json'),
    foldersInAppData: path.join(fx.appData, 'folders.json'),
    put(rel, content = 'x') {
      const file = path.join(fx.root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
  };
}

/** The legacy library: a folder list plus meeting files sitting in their old chain directories. */
export function seedLegacyLibrary(fx: MigrationFixture): void {
  fs.writeFileSync(fx.foldersInLibrary, legacyFoldersText());
  fx.put('Inbox/2026-09-02 Standup.md', '---\nid: a\n---\n');
  fx.put('Universidad/Cálculo/2026-09-01 Clase.md', '---\nid: b\n---\n');
  fx.put('Universidad/Cálculo/2026-09-01 Clase.wav', 'RIFF');
  fx.put('Universidad/Cálculo/Derivadas/2026-09-03 Derivadas.md', '---\nid: c\n---\n');
  fx.put('Trabajo/Cálculo/2026-09-04 Otra.md', '---\nid: d\n---\n');
}

/** Everything under the Library except the app's own directory and the old list. */
export function meetingFiles(fx: MigrationFixture): string[] {
  return tree(fx.root).filter((f) => !f.startsWith('.vozella/') && f !== 'folders.json');
}

export function projectJson(fx: MigrationFixture, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fx.context.layout.projectJsonFile(id), 'utf8')) as Record<
    string,
    unknown
  >;
}

export function readManifestFile(fx: MigrationFixture): Record<string, unknown> | null {
  return fs.existsSync(fx.context.layout.manifestFile)
    ? (JSON.parse(fs.readFileSync(fx.context.layout.manifestFile, 'utf8')) as Record<
        string,
        unknown
      >)
    : null;
}

export const backupFiles = (fx: MigrationFixture): string[] =>
  fs.existsSync(fx.context.layout.backupsDirectory)
    ? fs.readdirSync(fx.context.layout.backupsDirectory).sort()
    : [];

export const PROJECT_VERSION = STORAGE_KIND_VERSIONS.project;
