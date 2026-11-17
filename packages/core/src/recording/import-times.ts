export interface ImportTimes {
  readonly recordedAtMs: number;
  readonly endedAtMs: number;
}

/**
 * The meeting times of an imported file . The file's last-write time is when the recording ended, so it is not
 * used as the start (a voice memo would land after its real end): the file time is the end and the start is derived.
 * A time that is missing or unreadable means "now", also read as the end.
 */
export function importTimes(
  fileTimeMs: number | null,
  durationMs: number,
  nowMs: number,
): ImportTimes {
  const known = fileTimeMs !== null && Number.isFinite(fileTimeMs) && fileTimeMs > 0;
  const endedAtMs = known ? fileTimeMs : nowMs;
  const length = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  return { recordedAtMs: endedAtMs - length, endedAtMs };
}
