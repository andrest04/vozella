import nodePath from 'node:path';

export const ENV_DATA_ROOT = 'VOZELLA_DATA_ROOT';
/** Folder name of an earlier install's data. Agents and tests must never touch it. */
export const GUARDED_FOLDER_NAME = 'MeetingLive';
/** Folder name Vozella itself uses for its real data. */
const OWN_FOLDER_NAME = 'Vozella';

export type RunMode = 'production' | 'development' | 'test';

export type PathApi = typeof nodePath.win32;

export interface DataRootInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly mode: RunMode;
  /** %LOCALAPPDATA% */
  readonly localAppData: string;
  /** The user's Documents known folder (it can be redirected, so it is passed in). */
  readonly documents: string;
  readonly tempDir: string;
  /** Defaults to the host `path`. Tests pass `path.win32` to run the same cases anywhere. */
  readonly pathApi?: PathApi;
  /** Resolves symlinks and junctions. Failures fall back to the unresolved path. */
  readonly realpath?: (path: string) => string;
}

export interface DataRoots {
  /** Settings, logs, caches, models. */
  readonly appData: string;
  /** Default folder for meetings. */
  readonly meetings: string;
  readonly source: 'env' | 'default' | 'dev-fallback';
}

export class ForbiddenDataRootError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `Refusing to use "${path}" as a Vozella data root: ${reason}. ` +
        `Set ${ENV_DATA_ROOT} to a temporary folder.`,
    );
    this.name = 'ForbiddenDataRootError';
  }
}

export class InvalidDataRootError extends Error {
  constructor(readonly path: string) {
    super(`${ENV_DATA_ROOT} must be an absolute path, got "${path}"`);
    this.name = 'InvalidDataRootError';
  }
}

/**
 * The real user data folders of an earlier install and of Vozella itself. Agents and tests
 * must never touch them.
 */
export function protectedRoots(
  input: Pick<DataRootInput, 'localAppData' | 'documents' | 'pathApi'>,
  options: { readonly allowOwnFolders?: boolean } = {},
) {
  const p = input.pathApi ?? nodePath;
  const roots = [
    p.join(input.documents, GUARDED_FOLDER_NAME),
    p.join(input.localAppData, GUARDED_FOLDER_NAME),
  ];
  if (!options.allowOwnFolders) {
    roots.push(
      p.join(input.documents, OWN_FOLDER_NAME),
      p.join(input.localAppData, OWN_FOLDER_NAME),
    );
  }
  return roots;
}

/** True when `child` is `parent` or inside it. Windows paths compare case-insensitively. */
export function isUnderOrEqual(
  child: string,
  parent: string,
  pathApi: PathApi = nodePath,
): boolean {
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

/**
 * Throws if `candidate` is, or is inside, one of the protected real data folders, or if any
 * of its segments is named MeetingLive (covers a relocated Documents folder).
 * `allowOwnFolders` lets Vozella's own default folders through (production default only).
 */
export function assertNotProtectedRoot(
  candidate: string,
  input: DataRootInput,
  options: { readonly allowOwnFolders?: boolean } = {},
): void {
  const p = input.pathApi ?? nodePath;
  const real = (value: string): string => {
    try {
      return input.realpath ? input.realpath(value) : value;
    } catch {
      return value;
    }
  };
  const resolved = p.resolve(candidate);
  const variants = new Set([resolved, p.resolve(real(resolved))]);
  const protectedPaths = protectedRoots(input, options).flatMap((root) => [
    p.resolve(root),
    p.resolve(real(root)),
  ]);
  for (const path of variants) {
    for (const root of protectedPaths) {
      if (isUnderOrEqual(path, root, p)) {
        throw new ForbiddenDataRootError(candidate, `it is inside the real data folder "${root}"`);
      }
    }
    const named = path
      .split(/[\\/]+/)
      .some((segment) => segment.toLowerCase() === GUARDED_FOLDER_NAME.toLowerCase());
    if (named) {
      throw new ForbiddenDataRootError(candidate, `a path segment is named ${GUARDED_FOLDER_NAME}`);
    }
  }
}

/**
 * Where the app keeps its data.
 *
 * - VOZELLA_DATA_ROOT set: `<root>/app` and `<root>/meetings`. Refused, in every mode, when it
 *   points at a real data folder (MeetingLive or Vozella's own). Used by all agent and test runs.
 * - Packaged and unset: `%LOCALAPPDATA%\Vozella` and `Documents\Vozella`.
 * - Dev or test and unset: a throwaway folder in the OS temp directory, never a real one.
 */
export function resolveDataRoots(input: DataRootInput): DataRoots {
  const p = input.pathApi ?? nodePath;
  const fromEnv = input.env[ENV_DATA_ROOT]?.trim();

  let roots: DataRoots;
  if (fromEnv) {
    if (!p.isAbsolute(fromEnv)) {
      throw new InvalidDataRootError(fromEnv);
    }
    const root = p.resolve(fromEnv);
    assertNotProtectedRoot(root, input);
    roots = { appData: p.join(root, 'app'), meetings: p.join(root, 'meetings'), source: 'env' };
  } else if (input.mode === 'production') {
    roots = {
      appData: p.join(input.localAppData, 'Vozella'),
      meetings: p.join(input.documents, 'Vozella'),
      source: 'default',
    };
  } else {
    const root = p.join(input.tempDir, 'vozella-dev-data');
    roots = {
      appData: p.join(root, 'app'),
      meetings: p.join(root, 'meetings'),
      source: 'dev-fallback',
    };
  }

  // The production default IS Vozella's own folders; every other source must avoid them.
  const options = { allowOwnFolders: roots.source === 'default' };
  assertNotProtectedRoot(roots.appData, input, options);
  assertNotProtectedRoot(roots.meetings, input, options);
  return roots;
}
