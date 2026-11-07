/**
 * The version an unpackaged run shows in About, e.g. `0.9.7+51 (b64ffb3, dev)`: the last release
 * tag, the commits since it and the commit it was built from. electron.vite.config.ts runs git
 * once per build or dev start and bakes the result in as `__VOZELLA_DEV_VERSION__`; packaged
 * builds ignore it and show the version the release workflow wrote into package.json.
 */

declare const __VOZELLA_DEV_VERSION__: string | undefined;

export interface DescribeResult {
  readonly version: string;
  readonly commits: number;
  readonly sha: string;
}

/** Parses `git describe --tags --long` output such as `v0.9.7-51-gb64ffb3`. */
export function parseDescribe(output: string): DescribeResult | null {
  const match = /^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(output.trim());
  if (!match) return null;
  const [, version = '', commits = '0', sha = ''] = match;
  return { version, commits: Number(commits), sha };
}

export function formatDevVersion({ version, commits, sha }: DescribeResult): string {
  return `${commits > 0 ? `${version}+${commits}` : version} (${sha}, dev)`;
}

/**
 * Asks git through `run` (arguments after `git`, returns stdout, throws on failure). Without a
 * release tag the package version stands in; without git, only `(dev)` marks the run.
 */
export function readDevVersion(run: (args: string[]) => string, packageVersion: string): string {
  try {
    const parsed = parseDescribe(run(['describe', '--tags', '--long', '--match', 'v[0-9]*']));
    if (parsed) return formatDevVersion(parsed);
  } catch {
    // No reachable tag, or no git: try the commit alone.
  }
  try {
    const sha = run(['rev-parse', '--short', 'HEAD']).trim();
    if (sha) return `${packageVersion} (${sha}, dev)`;
  } catch {
    // No git at all.
  }
  return `${packageVersion} (dev)`;
}

/** The version baked in at build time, or undefined when the build did not define it. */
export function builtDevVersion(): string | undefined {
  return typeof __VOZELLA_DEV_VERSION__ === 'string' ? __VOZELLA_DEV_VERSION__ : undefined;
}
