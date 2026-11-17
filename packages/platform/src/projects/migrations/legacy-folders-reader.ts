import { stripBom, type LegacyFolderEntry } from '@vozella/core';

/** The old folder list cannot be read as a list. The step stops and nothing is written. */
export class LegacyFoldersError extends Error {
  constructor(detail: string) {
    super(`The old folder list cannot be read: ${detail}`);
    this.name = 'LegacyFoldersError';
  }
}

const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The only code that still knows the shape of the old `folders.json`: a JSON array, possibly with
 * a byte order mark, CRLF line endings and any key case (`Id`, `parentID`). It yields the raw
 * entries and validates nothing: ids, names and dates are checked by `planProjects`.
 */
export function readLegacyFolders(text: string): LegacyFolderEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (error) {
    throw new LegacyFoldersError(error instanceof Error ? error.message : 'invalid JSON');
  }
  if (!Array.isArray(raw)) throw new LegacyFoldersError('expected a JSON array');
  return (raw as unknown[]).map((entry) => {
    const keys = new Map<string, unknown>();
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      for (const [key, value] of Object.entries(entry)) keys.set(key.toLowerCase(), value);
    }
    return {
      id: string(keys.get('id')),
      name: string(keys.get('name')),
      parentId: string(keys.get('parentid')),
      note: string(keys.get('note')),
      createdAt: string(keys.get('createdat')),
    };
  });
}
