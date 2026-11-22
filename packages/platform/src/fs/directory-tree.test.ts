import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFilesRecursive, listSubdirectories } from './directory-tree';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-tree-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function touch(...parts: string[]): string {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

describe('listFilesRecursive', () => {
  it('lists every file under the folder, nested ones included, and no folders', () => {
    const files = [touch('a.dll'), touch('bin', 'b.dll'), touch('bin', 'deep', 'c.exe')];
    fs.mkdirSync(path.join(dir, 'empty'));
    expect(listFilesRecursive(dir).sort()).toEqual(files.sort());
  });

  it('gives an empty list for an empty folder', () => {
    expect(listFilesRecursive(dir)).toEqual([]);
  });
});

describe('listSubdirectories', () => {
  it('gives the full path of each direct subfolder, not files or nested folders', () => {
    touch('file.txt');
    touch('one', 'inner', 'x.txt');
    fs.mkdirSync(path.join(dir, 'two'));
    expect(listSubdirectories(dir).sort()).toEqual(
      [path.join(dir, 'one'), path.join(dir, 'two')].sort(),
    );
  });

  it('gives an empty list when the folder cannot be read', () => {
    expect(listSubdirectories(path.join(dir, 'missing'))).toEqual([]);
  });
});
