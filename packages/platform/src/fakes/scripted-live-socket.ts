import type {
  LiveSocket,
  LiveSocketEvent,
  LiveSocketEventType,
  LiveSocketFactory,
} from '../transcription/live-socket';

/**
 * Fake: a live speech socket that does nothing on its own. It records what the adapter sent and
 * the test plays the server: `open()`, `message()`, `fail()`, `serverClose()`. No network.
 */
export class ScriptedLiveSocket implements LiveSocket {
  binaryType = 'blob';
  /** Every frame sent, in order: text frames as strings, binary frames as copied bytes. */
  readonly sent: (string | Uint8Array)[] = [];
  /** The codes `close` was called with (undefined when it gave none). */
  readonly closes: (number | undefined)[] = [];
  /** When set, `send` throws it (a socket that is no longer open). */
  sendError: Error | null = null;
  private readonly listeners = new Map<LiveSocketEventType, ((event: LiveSocketEvent) => void)[]>();

  constructor(
    readonly url: string,
    readonly headers: Readonly<Record<string, string>>,
  ) {}

  /** The `type` of each text frame sent, in order. */
  get sentTypes(): string[] {
    return this.sent.flatMap((frame) =>
      typeof frame === 'string' ? [(JSON.parse(frame) as { type: string }).type] : [],
    );
  }

  /** The binary frames sent, in order. */
  get sentAudio(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }

  addEventListener(type: LiveSocketEventType, listener: (event: LiveSocketEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data));
  }

  close(code?: number): void {
    this.closes.push(code);
  }

  /** The server accepted the connection. */
  open(): void {
    this.emit('open', {});
  }

  /** A frame from the server: a string as it is, anything else as its JSON text. */
  message(value: unknown): void {
    this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  /** A binary frame from the server. */
  binary(data: ArrayBuffer): void {
    this.emit('message', { data });
  }

  /** The `error` event that precedes the close of a failed connection. */
  fail(): void {
    this.emit('error', {});
  }

  /** The connection is gone, with the close code the server (or the runtime) gave. */
  serverClose(code: number, reason = ''): void {
    this.emit('close', { code, reason });
  }

  private emit(type: LiveSocketEventType, event: LiveSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** The socket factory of a test: every socket the adapter opened, in order. */
export class ScriptedLiveSockets {
  readonly sockets: ScriptedLiveSocket[] = [];
  /** When set, creating a socket throws it. */
  createError: Error | null = null;

  readonly factory: LiveSocketFactory = (url, headers) => {
    if (this.createError !== null) throw this.createError;
    const socket = new ScriptedLiveSocket(url, headers);
    this.sockets.push(socket);
    return socket;
  };
}
