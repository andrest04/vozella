/** Strips a leading byte order mark. Node's file reader does not. Files written by earlier versions may start with one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
