/** Strips a leading byte order mark. Node's file reader does not. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
