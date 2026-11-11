/** One server-sent event: its `event:` name (null when unnamed) and its `data:` lines joined. */
export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

export interface SseParser {
  /** Feeds decoded text; returns the events completed by it. A partial line waits for more. */
  push(text: string): SseEvent[];
  /** The last event when the body ended without its closing blank line. */
  flush(): SseEvent[];
}

/**
 * Incremental `text/event-stream` reader. Bytes arrive in arbitrary pieces, so a line (and an
 * event) is only read once its terminator is in. Comments and events without data are dropped.
 */
export function createSseParser(): SseParser {
  let buffer = '';
  let name: string | null = null;
  let data: string[] = [];

  const dispatch = (out: SseEvent[]): void => {
    if (data.length > 0) out.push({ event: name, data: data.join('\n') });
    name = null;
    data = [];
  };

  const readLine = (line: string, out: SseEvent[]): void => {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') name = value;
  };

  return {
    push(text) {
      buffer += text;
      const out: SseEvent[] = [];
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        readLine(line, out);
        end = buffer.indexOf('\n');
      }
      return out;
    },
    flush() {
      const out: SseEvent[] = [];
      if (buffer !== '') readLine(buffer.replace(/\r$/, ''), out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}
