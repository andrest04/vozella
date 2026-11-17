// A frozen copy of the rule the old folder tree used to name a folder's directory. Migrated
// projects keep the directory their meetings already sit in, so the migration must compute exactly
// what the old rule computed. Nothing else uses this file, and it must never change.

// The control characters are exactly what Windows forbids in file names.
// eslint-disable-next-line no-control-regex
const INVALID_FILE_NAME_CHARS = /["<>|:*?\\/\u0000-\u001f]/g;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 80;
const RESERVED = ['inbox', 'meetings', 'recordings'];

const trimEdges = (value: string): string => value.trimStart().replace(/[\s.]+$/u, '');

function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function sanitize(name: string): string {
  if (name.trim() === '') return 'Meeting';
  let value = name.trim().replace(INVALID_FILE_NAME_CHARS, ' ').replace(/ {2,}/g, ' ');
  value = trimEdges(value);
  value = trimEdges(cut(value, MAX_LENGTH));
  if (value.trim() === '') return 'Meeting';
  if (value.toLowerCase() === 'inbox') return 'Inbox folder';
  return value.replace(/^[^.]*/u, (stem) => (DEVICE_NAME.test(stem) ? `${stem}_` : stem));
}

/** The directory name the old tree gave a folder with this (raw) name. */
export function legacyDirectoryName(name: string): string {
  const safe = sanitize(name);
  return RESERVED.includes(safe.toLowerCase()) ? `${safe} folder` : safe;
}
