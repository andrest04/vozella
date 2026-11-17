import { describe, expect, it } from 'vitest';
import {
  INBOX_DIR_NAME,
  META_DIR_NAME,
  STORAGE_SCHEMA_VERSION,
  createStorageLayout,
} from './storage-layout';

const ID = '9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b';
const FILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const joiner = { join: (...parts: string[]) => parts.join('/') };
const layout = createStorageLayout('lib/root', joiner);
const at = (...parts: string[]) => ['lib', 'root', ...parts].join('/');

describe('createStorageLayout', () => {
  it('names the constants of the storage', () => {
    expect(META_DIR_NAME).toBe('.vozella');
    expect(INBOX_DIR_NAME).toBe('Inbox');
    expect(STORAGE_SCHEMA_VERSION).toBe(1);
  });

  it('places the manifest, backups and projects under .vozella', () => {
    expect(layout.manifestFile).toBe(at('.vozella', 'library.json'));
    expect(layout.backupsDirectory).toBe(at('.vozella', 'backups'));
    expect(layout.projectsDirectory).toBe(at('.vozella', 'projects'));
    expect(layout.inboxDirectory).toBe(at('Inbox'));
  });

  it('places a project and its files', () => {
    expect(layout.projectDirectory(ID)).toBe(at('.vozella', 'projects', ID));
    expect(layout.projectJsonFile(ID)).toBe(at('.vozella', 'projects', ID, 'project.json'));
    expect(layout.filesDirectory(ID)).toBe(at('.vozella', 'projects', ID, 'files'));
    expect(layout.fileDirectory(ID, FILE)).toBe(at('.vozella', 'projects', ID, 'files', FILE));
  });

  it('places the chats of a project and of no project', () => {
    expect(layout.chatsDirectory(ID)).toBe(at('.vozella', 'projects', ID, 'chats'));
    expect(layout.threadFile(ID, FILE)).toBe(
      at('.vozella', 'projects', ID, 'chats', `${FILE}.json`),
    );
    expect(layout.chatsDirectory(null)).toBe(at('.vozella', 'no-project', 'chats'));
    expect(layout.threadFile(null, FILE)).toBe(
      at('.vozella', 'no-project', 'chats', `${FILE}.json`),
    );
  });

  it('refuses an id that is not a canonical lowercase GUID', () => {
    const bad = [
      '',
      '..',
      '../x',
      'a/b',
      'a\\b',
      ID.toUpperCase(),
      ID.replaceAll('-', ''),
      `{${ID}}`,
      `${ID}/..`,
      'CON',
    ];
    for (const id of bad) {
      expect(() => layout.projectDirectory(id)).toThrow();
      expect(() => layout.projectJsonFile(id)).toThrow();
      expect(() => layout.filesDirectory(id)).toThrow();
      expect(() => layout.chatsDirectory(id)).toThrow();
      expect(() => layout.fileDirectory(ID, id)).toThrow();
      expect(() => layout.fileDirectory(id, FILE)).toThrow();
      expect(() => layout.threadFile(ID, id)).toThrow();
      expect(() => layout.threadFile(id, FILE)).toThrow();
    }
  });

  it('two ids that differ only by case cannot reach the same path: the upper-case one throws', () => {
    expect(() => layout.projectDirectory(ID.toUpperCase())).toThrow();
    expect(layout.projectDirectory(ID)).not.toBe('');
  });
});
