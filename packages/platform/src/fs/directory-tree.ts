import fs from 'node:fs';
import nodePath from 'node:path';

/** Every file under `dir`, nested folders included (folders themselves are not listed). */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/** The full path of each direct subfolder of `folder`; empty when it cannot be read. */
export function listSubdirectories(folder: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => nodePath.join(folder, e.name));
}
