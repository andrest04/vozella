// Prints the next release version, computed from the last `v*` tag and the Conventional
// Commits since it. Dependency-free so the release workflow can run it before any install.
//
//   node scripts/next-version.mjs
//
// Rules: a breaking change (`type!:` or a `BREAKING CHANGE:` footer) bumps the minor while the
// major is 0, and the major from 1.x; otherwise any `feat` bumps the minor; anything else bumps
// the patch. No tag: the version in apps/desktop/package.json. No commits since the tag: the tag
// version itself, unchanged; the release workflow refuses to publish a version that is already
// tagged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `v1.2.3` or `1.2.3` as numbers, or null for anything else. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

const HEADER = /^(\w+)(\([^)]*\))?(!)?: /;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;

/** The largest bump the commit messages (subject and body) ask for. */
export function bumpLevel(messages) {
  let level = 'none';
  for (const message of messages) {
    const header = HEADER.exec(message.split('\n', 1)[0] ?? '');
    if (header?.[3] === '!' || BREAKING_FOOTER.test(message)) return 'major';
    if (header?.[1] === 'feat') level = 'minor';
    else if (level === 'none') level = 'patch';
  }
  return level;
}

/** The version after `lastTag`, given the commit messages since it. */
export function nextVersion(lastTag, messages, fallback) {
  const current = lastTag === null ? null : parseVersion(lastTag);
  if (current === null) return fallback;
  const { major, minor, patch } = current;
  switch (bumpLevel(messages)) {
    case 'major':
      return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return `${major}.${minor}.${patch}`;
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  let tag = null;
  try {
    tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']).trim() || null;
  } catch {
    // No release tag yet: the package version is the first one.
  }
  const messages =
    tag === null
      ? []
      : git(['log', `${tag}..HEAD`, '--format=%B%x00'])
          .split('\0')
          .map((message) => message.trim())
          .filter((message) => message.length > 0);
  process.stdout.write(`${nextVersion(tag, messages, manifest.version)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
