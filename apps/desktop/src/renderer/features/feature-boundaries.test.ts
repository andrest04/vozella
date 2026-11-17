import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const featuresDir = __dirname;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The feature folder a relative import lands in, or null when it leaves features. */
function featureOfImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(featuresDir, target);
  if (relative.startsWith('..')) return null;
  return relative.split(path.sep)[0] ?? null;
}

function importedFeatures(feature: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(path.join(featuresDir, feature))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import\(|vi\.mock\()\s*['"](\.[^'"]*)['"]/g)) {
      const other = featureOfImport(file, match[1] ?? '');
      if (other !== null && other !== feature) {
        found.set(other, [...(found.get(other) ?? []), path.relative(featuresDir, file)]);
      }
    }
  }
  return found;
}

describe('feature boundaries', () => {
  it('features/library and features/projects never import each other', () => {
    expect([...(importedFeatures('library').get('projects') ?? [])]).toEqual([]);
    expect([...(importedFeatures('projects').get('library') ?? [])]).toEqual([]);
  });

  it('the shared meeting list imports neither the library nor the projects', () => {
    const imported = importedFeatures('meeting-list');
    expect(imported.get('library') ?? []).toEqual([]);
    expect(imported.get('projects') ?? []).toEqual([]);
  });

  it('the scan sees imports: the library reads the shared meeting list', () => {
    expect(importedFeatures('library').has('meeting-list')).toBe(true);
  });
});
