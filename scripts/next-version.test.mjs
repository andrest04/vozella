// Run with: node --test "scripts/*.test.mjs" (part of the root `pnpm test`).
// node:test keeps the script dependency-free; vitest is not installed at the workspace root.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bumpLevel, nextVersion, parseVersion } from './next-version.mjs';

describe('parseVersion', () => {
  it('reads a tag with or without the leading v', () => {
    assert.deepEqual(parseVersion('v0.9.7'), { major: 0, minor: 9, patch: 7 });
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  });

  it('rejects text that is not a version', () => {
    assert.equal(parseVersion('release'), null);
    assert.equal(parseVersion('v1.2'), null);
  });
});

describe('bumpLevel', () => {
  it('is none without commits', () => {
    assert.equal(bumpLevel([]), 'none');
  });

  it('is patch for fixes, chores and merges', () => {
    assert.equal(bumpLevel(['fix(app): crash', 'chore: deps', 'merge: feat/x into main']), 'patch');
  });

  it('is minor when any commit is a feature, with or without scope', () => {
    assert.equal(bumpLevel(['fix: a', 'feat: b']), 'minor');
    assert.equal(bumpLevel(['feat(ui): wider pages']), 'minor');
  });

  it('does not take a merge subject that names a feature branch as a feature', () => {
    assert.equal(bumpLevel(['merge: feat/content-width into main']), 'patch');
    assert.equal(bumpLevel(["Merge branch 'feat/x'"]), 'patch');
  });

  it('is major for a bang header or a BREAKING CHANGE footer', () => {
    assert.equal(bumpLevel(['feat(api)!: drop v1']), 'major');
    assert.equal(bumpLevel(['refactor: storage\n\nBREAKING CHANGE: new folder layout']), 'major');
    assert.equal(bumpLevel(['fix: x\n\nBREAKING-CHANGE: y']), 'major');
  });

  it('ignores BREAKING CHANGE when it is not a footer at the start of a line', () => {
    assert.equal(bumpLevel(['docs: explain what a BREAKING CHANGE: means']), 'patch');
  });
});

describe('nextVersion', () => {
  it('bumps the patch for fixes only', () => {
    assert.equal(nextVersion('v0.9.7', ['fix: a', 'chore: b'], '0.0.0'), '0.9.8');
  });

  it('bumps the minor and resets the patch when a feature landed', () => {
    assert.equal(nextVersion('v0.9.7', ['fix: a', 'feat: b'], '0.0.0'), '0.10.0');
  });

  it('treats a breaking change as a minor bump while the major is 0', () => {
    assert.equal(nextVersion('v0.9.7', ['feat!: b'], '0.0.0'), '0.10.0');
  });

  it('bumps the major from 1.x on a breaking change', () => {
    assert.equal(nextVersion('v1.4.2', ['fix!: b'], '0.0.0'), '2.0.0');
  });

  it('keeps the tag version when nothing was committed since it', () => {
    assert.equal(nextVersion('v0.9.7', [], '0.0.0'), '0.9.7');
  });

  it('uses the fallback when there is no tag', () => {
    assert.equal(nextVersion(null, ['feat: a'], '0.9.0'), '0.9.0');
  });
});
