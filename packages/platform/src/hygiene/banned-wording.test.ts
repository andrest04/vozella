import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

/** Not ours to police: dependencies, build output and agent tooling. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.agents',
  '.atl',
  '.codegraph',
  'out',
  'dist',
  'release',
  'release-e2e',
  'target',
  'test-results',
  'playwright-report',
]);
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|css|md|json|yml|yaml|toml|html)$/i;
const TEXT_FILE_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig']);
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'skills-lock.json']);

/** Files that implement or document the data-root guard, which names the real data folder. */
const ALLOWED_REAL_FOLDER_NAME = new Set([
  'packages/platform/src/data-root/resolve-data-root.ts',
  'packages/platform/src/data-root/resolve-data-root.test.ts',
  'packages/platform/src/library/library-runtime.test.ts',
  'apps/desktop/src/main/ipc/library-handlers.test.ts',
  'apps/desktop/e2e/launch.ts',
  'apps/desktop/e2e/library.spec.ts',
  'apps/desktop/e2e/library-ui.spec.ts',
  'apps/desktop/e2e/shell-platform.spec.ts',
  'AGENTS.md',
  'README.md',
  'PRODUCT.md',
  'docs/stack.md',
]);

// Every forbidden word is built from parts so that this file does not contain it.
const BANNED = new RegExp(
  [
    ['win', 'ui'].join(''),
    ['dot', 'net'].join(''),
    ['\\.', 'net', '\\b'].join(''),
    ['\\b', 'c', '#'].join(''),
    ['c', 'sharp'].join(''),
    ['one', 'drive'].join(''),
    ['docs', '/', 'port'].join(''),
    ['old', ' app'].join(''),
    ['original', ' app'].join(''),
    ['\\b', 'port', ' of'].join(''),
  ].join('|'),
  'i',
);
const REAL_FOLDER_NAME = new RegExp(['meeting', 'live'].join(''), 'i');
const STORED_LINK_HOST = new RegExp(['meeting', 'live', '\\.local'].join(''), 'gi');

function* textFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* textFiles(absolute);
    } else if (
      (TEXT_FILE.test(entry.name) || TEXT_FILE_NAMES.has(entry.name)) &&
      !SKIPPED_FILES.has(entry.name)
    ) {
      yield absolute;
    }
  }
}

const relativeOf = (file: string): string =>
  path.relative(repoRoot, file).split(path.sep).join('/');

describe('banned wording stays out of the repository', () => {
  it('has no reference to the removed app, its stack or its archive', () => {
    const offenders: string[] = [];
    for (const file of textFiles(repoRoot)) {
      if (BANNED.test(fs.readFileSync(file, 'utf8'))) offenders.push(relativeOf(file));
    }
    expect(offenders).toEqual([]);
  });

  it('names the real data folder only where the data-root guard lives', () => {
    const offenders: string[] = [];
    for (const file of textFiles(repoRoot)) {
      const relative = relativeOf(file);
      if (ALLOWED_REAL_FOLDER_NAME.has(relative)) continue;
      const text = fs.readFileSync(file, 'utf8').replace(STORED_LINK_HOST, '');
      if (REAL_FOLDER_NAME.test(text)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlisted file real', () => {
    const missing = [...ALLOWED_REAL_FOLDER_NAME].filter(
      (f) => !fs.existsSync(path.join(repoRoot, f)),
    );
    expect(missing).toEqual([]);
  });

  it('has no archive directory under docs', () => {
    expect(fs.existsSync(path.join(repoRoot, ['docs', 'port'].join('/')))).toBe(false);
  });
});
