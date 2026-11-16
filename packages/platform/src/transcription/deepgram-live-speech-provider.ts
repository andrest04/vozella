import {
  ApiProviderError,
  CancelSource,
  isApiProviderError,
  type CancelSignal,
  type CloudSpeechTimer,
  type StreamingSpeechListener,
  type StreamingSpeechOptions,
  type StreamingSpeechProvider,
  type StreamingSpeechResult,
  type StreamingSpeechSession,
} from '@vozella/core';
import { scrubSecret } from '../api-providers/api-http';
import {
  deepgramFailureKind,
  deepgramListenQuery,
  deepgramSeconds,
  deepgramWords,
  isJsonObject,
  secondsToMs,
  type Json,
} from './deepgram-listen';
import {
  float32ToPcm16,
  globalLiveSocket,
  type LiveSocket,
  type LiveSocketEvent,
  type LiveSocketFactory,
} from './live-socket';

/**
 * A `KeepAlive` goes out this often while the socket is open. Deepgram closes a stream that gets
 * neither audio nor a KeepAlive for ten seconds and asks for one every three to five; four held a
 * silent socket open in the probe of 2026-11-15.
 */
export const DEEPGRAM_KEEP_ALIVE_MS = 4_000;

export interface DeepgramLiveOptions {
  /** The provider name in errors. */
  readonly displayName: string;
  /** The HTTPS endpoint without a trailing slash; the socket uses the same host over `wss`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Read once per session, when it opens. */
  readonly apiKey: () => Promise<string | null>;
  /**
   * The wait between KeepAlives. It must really wait: a timer whose waits resolve at once would
   * send KeepAlives without pause.
   */
  readonly timer: CloudSpeechTimer;
  /**
   * Asks the provider over HTTP whether it accepts the key: resolves when it does, rejects with
   * the `ApiProviderError` of the answer when it does not or cannot be reached. Only called for a
   * session that never opened, to tell a refused key from a network that is down.
   */
  readonly checkKey: (key: string, cancel: CancelSignal) => Promise<void>;
  /** Tests replace it; production uses the runtime's `WebSocket`. */
  readonly socket?: LiveSocketFactory;
}

/**
 * Adapter: Deepgram's live `wss://…/listen`, one socket per session. Audio goes out as raw 16-bit
 * mono PCM; `Results` messages come back as interim and final results whose word times already
 * count from the start of the stream. Messages and close codes are in the feature document
 * (odd/tasks/deepgram-streaming-transcription.md, observed 2026-11-15).
 *
 * Everything the server sends is untrusted: a message that is not a known, well-formed one is
 * ignored, and nothing thrown while reading one leaves the handler. The key travels in the
 * `Authorization` header only, never in the URL, and is scrubbed from any server text kept in an
 * error.
 */
export class DeepgramLiveSpeechProvider implements StreamingSpeechProvider {
  /** What the sessions of this provider have learned, for the ones opened after them. */
  private readonly known: KnownKey = { accepted: null };

  constructor(private readonly options: DeepgramLiveOptions) {}

  get displayName(): string {
    return this.options.displayName;
  }

  open(options: StreamingSpeechOptions, listener: StreamingSpeechListener): StreamingSpeechSession {
    return new DeepgramLiveSession(this.options, options, listener, this.known);
  }
}

/**
 * The key a session of the provider opened with. The streaming engine opens a new session after a
 * drop, and while the network is down each of them fails to open: with a key the provider has
 * already taken, that is a connection failure and the key check is not sent again.
 */
interface KnownKey {
  accepted: string | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

class DeepgramLiveSession implements StreamingSpeechSession {
  /** Over, from either side: nothing more is sent and the listener hears nothing more. */
  private done = false;
  private isOpen = false;
  private finishing = false;
  /** The key check of a session that never opened is running. */
  private explaining = false;
  private key = '';
  private socket: LiveSocket | null = null;
  /** Cancelled when the KeepAlives must stop. */
  private readonly alive = new CancelSource();
  /** Stops listening to the pass's cancel. Set before the listener, which may run at once. */
  private unlink: () => void = () => undefined;

  constructor(
    private readonly options: DeepgramLiveOptions,
    private readonly stream: StreamingSpeechOptions,
    private readonly listener: StreamingSpeechListener,
    private readonly known: KnownKey,
  ) {
    this.unlink = stream.cancel.onCancel(() => {
      this.close();
    });
    void this.start();
  }

  send(samples: Float32Array): void {
    if (this.done || !this.isOpen || this.finishing || samples.length === 0) return;
    this.transmit(float32ToPcm16(samples));
  }

  finish(): void {
    if (this.done || this.finishing) return;
    if (!this.isOpen) {
      // Nothing was sent, so there is nothing to wait for.
      this.end(null);
      return;
    }
    this.finishing = true;
    this.alive.cancel();
    // Finalize flushes the audio still being listened to; CloseStream then ends the stream, which
    // the server answers with a Metadata message and a normal close.
    if (this.transmit(JSON.stringify({ type: 'Finalize' }))) {
      this.transmit(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  close(): void {
    if (this.done) return;
    this.shut();
  }

  private async start(): Promise<void> {
    const { displayName } = this.options;
    let key: string;
    try {
      key = (await this.options.apiKey())?.trim() ?? '';
    } catch {
      // The store's own message is not kept: it is not about the provider.
      this.end(new ApiProviderError(displayName, 'Unknown', 'The key could not be read.'));
      return;
    }
    if (this.done) return;
    if (key === '') {
      this.end(new ApiProviderError(displayName, 'KeyMissing'));
      return;
    }
    this.key = key;
    const query = deepgramListenQuery({
      model: this.options.model,
      language: this.stream.language,
      live: { sampleRate: this.stream.sampleRate },
    });
    const url = `${this.options.baseUrl.replace(/^http/i, 'ws')}/listen?${query}`;
    let socket: LiveSocket;
    try {
      socket = (this.options.socket ?? globalLiveSocket)(url, { Authorization: `Token ${key}` });
    } catch {
      void this.explainNeverOpened();
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      this.onOpen();
    });
    socket.addEventListener('message', (event) => {
      try {
        this.onMessage(event.data);
      } catch {
        // A message that cannot be read is not worth the session.
      }
    });
    socket.addEventListener('error', () => {
      // After the open, the close that follows carries the code; before it, nothing else will.
      if (!this.isOpen) void this.explainNeverOpened();
    });
    socket.addEventListener('close', (event) => {
      this.onClose(event);
    });
  }

  private onOpen(): void {
    if (this.done) {
      this.closeSocket();
      return;
    }
    if (this.isOpen) return;
    this.isOpen = true;
    this.known.accepted = this.key;
    void this.keepAlive();
    this.listener.opened();
  }

  private async keepAlive(): Promise<void> {
    for (;;) {
      await this.options.timer.wait(DEEPGRAM_KEEP_ALIVE_MS, this.alive.signal);
      if (this.alive.cancelled) return;
      this.transmit(JSON.stringify({ type: 'KeepAlive' }));
    }
  }

  /** Sends one frame. A socket that refuses it has dropped: the session ends. False when it did. */
  private transmit(frame: string | Uint8Array<ArrayBuffer>): boolean {
    if (this.done || this.socket === null) return false;
    try {
      this.socket.send(frame);
      return true;
    } catch {
      this.end(new ApiProviderError(this.options.displayName, 'Network'));
      return false;
    }
  }

  private onMessage(data: unknown): void {
    // Text frames only: the server sends JSON, and audio never comes back.
    if (this.done || !this.isOpen || typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isJsonObject(message)) return;
    switch (message.type) {
      case 'Results':
        this.onResults(message);
        return;
      case 'Metadata':
        // Sent once the stream was closed with CloseStream: every final has already arrived.
        if (this.finishing) this.end(null);
        return;
      case 'Error':
        this.end(this.messageFailure(message));
        return;
      default:
        // SpeechStarted, UtteranceEnd and whatever the API adds later.
        return;
    }
  }

  private onResults(message: Json): void {
    const start = deepgramSeconds(message.start);
    const duration = deepgramSeconds(message.duration);
    const alternatives = isJsonObject(message.channel) ? message.channel.alternatives : undefined;
    const alternative: unknown = Array.isArray(alternatives) ? alternatives[0] : undefined;
    if (start === null || duration === null || !isJsonObject(alternative)) return;
    const result: StreamingSpeechResult = {
      text: text(alternative.transcript),
      // Seconds from the start of the stream, on every result.
      words: deepgramWords(alternative.words),
      processedMs: secondsToMs(start + duration),
    };
    if (message.is_final === true) this.listener.final(result);
    else this.listener.interim(result);
  }

  private onClose(event: LiveSocketEvent): void {
    if (this.done) return;
    if (!this.isOpen) {
      void this.explainNeverOpened();
      return;
    }
    // A normal close after CloseStream is the end of the stream even when no Metadata came.
    if (this.finishing && event.code === 1000) {
      this.end(null);
      return;
    }
    this.end(this.closeFailure(event));
  }

  /**
   * Why the session never opened. The socket says only that it failed (close code 1006, no HTTP
   * status), which a refused key and a dead network both look like; the key check tells them
   * apart. An accepted key leaves a connection failure, and so does a key an earlier session of
   * this provider opened with, which is not asked about again.
   */
  private async explainNeverOpened(): Promise<void> {
    if (this.done || this.explaining) return;
    this.explaining = true;
    const { displayName } = this.options;
    if (this.key !== '' && this.known.accepted === this.key) {
      this.end(new ApiProviderError(displayName, 'Network'));
      return;
    }
    let failure: ApiProviderError;
    try {
      await this.options.checkKey(this.key, this.stream.cancel);
      failure = new ApiProviderError(displayName, 'Network');
    } catch (error) {
      failure = isApiProviderError(error) ? error : new ApiProviderError(displayName, 'Network');
    }
    this.end(failure);
  }

  /** The failure of an `Error` message: its code picks the kind, its text is kept without the key. */
  private messageFailure(message: Json): ApiProviderError {
    const code = [message.err_code, message.code, message.variant].find(
      (candidate) => text(candidate) !== '',
    );
    const said = [message.err_msg, message.description, message.message]
      .map(text)
      .filter((part) => part !== '')
      .join(' ');
    return new ApiProviderError(
      this.options.displayName,
      deepgramFailureKind(code),
      scrubSecret(said === '' ? 'The provider reported an error.' : said, this.key),
    );
  }

  /**
   * The failure of a socket that closed while the session was open. 1011 is the server giving up
   * (no audio or KeepAlive in time, or its own timeout); 1008 is audio it could not decode, kept
   * with its reason; anything else, a normal close nobody asked for included, is a dropped
   * connection.
   */
  private closeFailure(event: LiveSocketEvent): ApiProviderError {
    const { displayName } = this.options;
    if (event.code === 1011) return new ApiProviderError(displayName, 'TimedOut');
    if (event.code === 1008) {
      const reason = scrubSecret(text(event.reason), this.key);
      return new ApiProviderError(displayName, 'Unknown', `The stream was refused. ${reason}`);
    }
    return new ApiProviderError(displayName, 'Network');
  }

  /** The session is over and the listener is told, once. */
  private end(error: ApiProviderError | null): void {
    if (this.done) return;
    this.shut();
    this.listener.closed(error);
  }

  private shut(): void {
    this.done = true;
    this.alive.cancel();
    this.unlink();
    this.closeSocket();
  }

  private closeSocket(): void {
    try {
      this.socket?.close();
    } catch {
      // A socket that is already closed, or never connected, has nothing to close.
    }
  }
}
