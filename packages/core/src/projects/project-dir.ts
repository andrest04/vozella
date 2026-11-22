import { INBOX_DIR_NAME } from './storage-layout';
import { foldText } from '../library/text-fold';
import { cutPrefix } from '../text/utf16-cut';

const MAX_DIR_LENGTH = 260;
const MAX_NAME_LENGTH = 80;
const DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// The control characters are exactly what Windows forbids in file names.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
// eslint-disable-next-line no-control-regex
const SANITIZE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

const isDevice = (segment: string): boolean => DEVICE_STEM.test(segment.split('.')[0] ?? '');

/**
 * The authoritative check of a project's frozen directory (relative to the Library root, with
 * `/` separators). Anything read from disk is untrusted: a corrupt or hand-edited file must not
 * aim a write or a delete outside the Library. Rejects an empty or absolute path, a drive letter,
 * a colon or backslash, an empty, `.`, `..` or dot-prefixed segment (so the metadata directory is
 * impossible), Windows device names (with or without an extension), a segment that ends in a dot
 * or a space, the characters `< > : " | ? *`, controls and anything over 260 characters.
 */
export function isSafeProjectDir(dir: string): boolean {
  if (dir === '' || dir.length > MAX_DIR_LENGTH) return false;
  if (dir.startsWith('/') || dir.endsWith('/')) return false;
  if (FORBIDDEN_CHARS.test(dir)) return false;
  return dir.split('/').every((segment) => {
    if (segment === '' || segment.startsWith('.')) return false;
    if (segment.endsWith('.') || segment.endsWith(' ')) return false;
    return !isDevice(segment);
  });
}

/**
 * One safe directory name for a new project: forbidden characters removed, whitespace collapsed,
 * leading dots and trailing dots and spaces stripped, at most 80 characters. Empty becomes
 * `Project`; a Windows reserved name gets the suffix ` project` on its stem (`nul.txt` becomes
 * `nul project.txt`).
 */
export function sanitizeDirName(name: string): string {
  const clean = (value: string): string => value.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');
  let value = name.replace(SANITIZE_CHARS, ' ').replace(/\s+/g, ' ');
  value = clean(cutPrefix(clean(value), MAX_NAME_LENGTH));
  if (value === '') return 'Project';
  return isDevice(value) ? value.replace(/^[^.]*/u, (stem) => `${stem} project`) : value;
}

/**
 * The directory of a new project, always exactly one segment. `taken` is every name that must
 * not be reused: entries of the Library root read at allocation time (user folders, a Library folder
 * with loose meetings) and the frozen directory of every project. Each entry counts with
 * its first segment too, so a new project can never be a prefix or a child of another project's
 * directory. `Inbox` is always taken. Comparison is folded (case and accents), which also matches
 * NTFS case-insensitivity. A taken name gets ` 2`, ` 3` and so on.
 */
export function allocateProjectDir(name: string, taken: Iterable<string>): string {
  const reserved = new Set<string>([foldText(INBOX_DIR_NAME)]);
  for (const entry of taken) {
    reserved.add(foldText(entry));
    const first = entry.split('/')[0];
    if (first !== undefined) reserved.add(foldText(first));
  }
  const base = sanitizeDirName(name);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base} ${String(n)}`;
    if (!reserved.has(foldText(candidate))) return candidate;
  }
}
