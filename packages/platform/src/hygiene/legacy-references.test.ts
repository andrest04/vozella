import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

/** Not ours to police: dependencies, build output, agent tooling, plans and the design record. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.agents',
  '.atl',
  'odd',
  'out',
  'dist',
  'release',
  'target',
  'test-results',
  'playwright-report',
]);
const SKIPPED_PATHS = new Set(['docs/design']);
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|css|md|json|yml|yaml|toml|html)$/i;
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'skills-lock.json']);

function* textFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || SKIPPED_PATHS.has(relative)) continue;
      yield* textFiles(absolute);
    } else if (TEXT_FILE.test(entry.name) && !SKIPPED_FILES.has(entry.name)) {
      yield absolute;
    }
  }
}

describe('legacy wording stays out of the repository', () => {
  it('has no mention of the cloud-sync product that the app no longer writes about', () => {
    // Built from two parts so that this file does not contain the word it forbids.
    const word = new RegExp(['one', 'drive'].join(''), 'i');
    const offenders: string[] = [];
    for (const file of textFiles(repoRoot)) {
      if (word.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(repoRoot, file).split(path.sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
