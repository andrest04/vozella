const GUID =
  /^[{(]?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})[})]?$/i;

/** Lowercase hyphenated form of any standard GUID text, or null. */
export function parseGuid(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = GUID.exec(text.trim());
  return match ? match.slice(1, 6).join('-').toLowerCase() : null;
}
