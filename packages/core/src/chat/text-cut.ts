/**
 * Code-point-safe cuts that still count UTF-16 units. Limits are counted in
 * JavaScript `length` units, and a cut never leaves half of a
 * surrogate pair behind: when the boundary falls inside a pair, the whole character is dropped.
 */

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The first `max` UTF-16 units, or fewer when the last one would split a surrogate pair. */
export function cutPrefix(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  let end = max;
  if (isHigh(value.charCodeAt(end - 1)) && isLow(value.charCodeAt(end))) end -= 1;
  return value.slice(0, end);
}

/** The last `max` UTF-16 units, or fewer when the first one would be half of a surrogate pair. */
export function cutTail(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  let start = value.length - max;
  if (isLow(value.charCodeAt(start)) && isHigh(value.charCodeAt(start - 1))) start += 1;
  return value.slice(start);
}
