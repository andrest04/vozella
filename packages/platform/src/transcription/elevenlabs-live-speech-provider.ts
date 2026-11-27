import {
  ApiProviderError,
  CancelSource,
  type CancelSignal,
  type CloudSpeechTimer,
  type SpeechToTextWord,
  type StreamingSpeechListener,
  type StreamingSpeechOptions,
  type StreamingSpeechProvider,
  type StreamingSpeechResult,
  type StreamingSpeechSession,
} from '@vozella/core';
import { scrubSecret } from '../api-providers/api-http';
import { isJsonObject, type Json } from './deepgram-listen';
import {
  ELEVENLABS_API_KEY_HEADER,
  ELEVENLABS_REALTIME_SAMPLE_RATE,
  elevenLabsFailureKind,
  elevenLabsRealtimeUrl,
  elevenLabsWords,
  isElevenLabsRealtimeError,
} from './elevenlabs-scribe';
import {
  float32ToPcm16,
  globalLiveSocket,
  type LiveSocket,
  type LiveSocketEvent,
  type LiveSocketFactory,
} from './live-socket';
import { LiveKeyCheck } from './live-key-check';

/** Audio goes out in chunks this long; the guide asks for 0.1 to 1 s. */
export const ELEVENLABS_CHUNK_MS = 250;

/**
 * A commit goes with the first quiet chunk once this much audio is uncommitted. The guide calls
 * 20 to 30 s good practice; the server commits by itself at about 36 s.
 */
export const ELEVENLABS_COMMIT_AFTER_MS = 20_000;

/** A commit goes with the chunk that reaches this much uncommitted audio, quiet or not. */
export const ELEVENLABS_FORCED_COMMIT_MS = 25_000;

/** A chunk below this RMS is quiet enough to cut at: a pause between words, not silence. */
export const ELEVENLABS_QUIET_RMS = 0.01;

/**
 * After this long without a chunk (a paused take), a short silence goes out: the server closes a
 * socket that hears nothing for 15 s, and keep-alives need audio.
 */
export const ELEVENLABS_IDLE_SILENCE_MS = 8_000;

/** How much silence an idle socket is sent; the guide's shortest chunk. */
export const ELEVENLABS_IDLE_SILENCE_CHUNK_MS = 100;

/** How long `finish` waits for the transcripts of the commits still unanswered. */
export const ELEVENLABS_FINISH_TIMEOUT_MS = 8_000;

/**
 * How long a plain `committed_transcript` waits for the timestamped one of the same commit before
 * it is given on its own. The docs do not say whether both come, nor in which order.
 */
export const ELEVENLABS_PLAIN_HOLD_MS = 1_500;

/**
 * Word times are read as counting from the start of their segment when the first word starts this
 * far before the segment did; otherwise as counting from the start of the session. The docs do
 * not say which clock committed words use (checked 2026-11-26).
 */
export const ELEVENLABS_SEGMENT_RELATIVE_SLACK_MS = 1_000;

const RATE = ELEVENLABS_REALTIME_SAMPLE_RATE;
const CHUNK_SAMPLES = (RATE * ELEVENLABS_CHUNK_MS) / 1000;
const SILENCE_SAMPLES = (RATE * ELEVENLABS_IDLE_SILENCE_CHUNK_MS) / 1000;
const samplesToMs = (samples: number): number => (samples * 1000) / RATE;

export interface ElevenLabsLiveOptions {
  /** The provider name in errors. */
  readonly displayName: string;
  /** The HTTPS API base without a trailing slash (`ELEVENLABS_BASE_URL`); the socket uses `wss`. */
  readonly baseUrl: string;
  /** The live model id (`scribe_v2_realtime`, `scribe_v3_live`). */
  readonly model: string;
  /** Read once per session, when it opens. */
  readonly apiKey: () => Promise<string | null>;
  /** The waits of the idle silence, the plain-commit hold and the finish timeout. */
  readonly timer: CloudSpeechTimer;
  /**
   * Asks the provider over HTTP whether it accepts the key: resolves when it does, rejects with
   * the `ApiProviderError` of the answer when it does not or cannot be reached. Only called for a
   * session that never started, to tell a refused key from a network that is down.
   */
  readonly checkKey: (key: string, cancel: CancelSignal) => Promise<void>;
  /** Tests replace it; production uses the runtime's `WebSocket`. */
  readonly socket?: LiveSocketFactory;
}

/**
 * Adapter: ElevenLabs Scribe realtime (`wss://…/v1/speech-to-text/realtime`), one socket per
 * session. Audio goes out as base64 16 kHz PCM in JSON `input_audio_chunk` frames; the app commits
 * itself (`commit: true` on a chunk) at a quiet point every 20 to 25 s, so it knows how far each
 * committed transcript reaches: that is the final's `processedMs`. Partials carry text only, so
 * their words are spread evenly over the uncommitted audio; finals use the committed words.
 *
 * Everything the server sends is untrusted: a message that is not a known, well-formed one is
 * ignored, and nothing thrown while reading one leaves the handler. The key travels in the
 * `xi-api-key` header only, never in the URL, and is scrubbed from any server text kept in an
 * error. Protocol: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */
export class ElevenLabsLiveSpeechProvider implements StreamingSpeechProvider {
  /** What the sessions of this provider have learned of the key, for the ones opened after them. */
  private readonly keyCheck: LiveKeyCheck;

  constructor(private readonly options: ElevenLabsLiveOptions) {
    this.keyCheck = new LiveKeyCheck(options.displayName, options.checkKey);
  }

  get displayName(): string {
    return this.options.displayName;
  }

  open(options: StreamingSpeechOptions, listener: StreamingSpeechListener): StreamingSpeechSession {
    return new ElevenLabsLiveSession(this.options, options, listener, this.keyCheck);
  }
}

/** One commit sent and not yet answered, in server milliseconds. */
interface CommitPoint {
  readonly startMs: number;
  readonly endMs: number;
}

/** Silence the adapter sent on its own, in server milliseconds: the engine never sent it. */
interface InjectedSilence {
  readonly atMs: number;
  readonly ms: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const rms = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += Number.isNaN(sample) ? 0 : sample * sample;
  return Math.sqrt(sum / samples.length);
};

const base64 = (bytes: Uint8Array<ArrayBuffer>): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/**
 * Approximate words for a text that came without times: its words spread evenly over the span.
 * Close enough for live text and for placing a line; the pass after Stop has the real times.
 */
function spreadWords(textValue: string, fromMs: number, toMs: number): SpeechToTextWord[] {
  const tokens = textValue.split(/\s+/).filter((token) => token !== '');
  const span = Math.max(0, toMs - fromMs);
  return tokens.map((token, i) => ({
    text: token,
    startMs: Math.round(fromMs + (span * i) / tokens.length),
    endMs: Math.round(fromMs + (span * (i + 1)) / tokens.length),
  }));
}

/**
 * Linear resampling to 16 kHz, kept across frames. No low-pass filter: the capture already gives
 * 16 kHz, so this only serves a source at another rate.
 */
class LinearResampler {
  /** Where the next output sample falls, in input samples from the start of the next frame. */
  private position = 0;
  /** The last sample of the previous frame, at position -1. */
  private last = 0;

  constructor(private readonly step: number) {}

  process(input: Float32Array): Float32Array {
    const out: number[] = [];
    while (this.position <= input.length - 1) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const from = index < 0 ? this.last : (input[index] ?? 0);
      const to = input[index + 1] ?? from;
      out.push(from + (to - from) * fraction);
      this.position += this.step;
    }
    this.position -= input.length;
    this.last = input[input.length - 1] ?? this.last;
    return Float32Array.from(out);
  }
}

type CommitMode = 'auto' | 'force';

class ElevenLabsLiveSession implements StreamingSpeechSession {
  /** Over, from either side: nothing more is sent and the listener hears nothing more. */
  private done = false;
  /** `session_started` came: the session takes audio. */
  private isOpen = false;
  private finishing = false;
  /** The key check of a session that never started is running. */
  private explaining = false;
  private key = '';
  private socket: LiveSocket | null = null;
  private readonly resampler: LinearResampler | null;
  /** 16 kHz audio not yet sent, oldest first. */
  private readonly buffered: Float32Array[] = [];
  private bufferedSamples = 0;
  /** 16 kHz samples the server was sent, idle silence included. */
  private serverSamples = 0;
  /** Where the uncommitted audio starts, in server ms: the end of the last commit sent. */
  private uncommittedFromMs = 0;
  /** How far the last answered commit reaches, in server ms. */
  private answeredMs = 0;
  private readonly points: CommitPoint[] = [];
  private readonly silences: InjectedSilence[] = [];
  /** A plain committed transcript waiting for its timestamped twin. */
  private heldPlain: string | null = null;
  /** Timestamped transcripts that came before their plain twin, whose twin is still to come. */
  private echoes = 0;
  private idle = new CancelSource();
  private hold = new CancelSource();
  private readonly finishWait = new CancelSource();
  /** Stops listening to the pass's cancel. Set before the listener, which may run at once. */
  private unlink: () => void = () => undefined;

  constructor(
    private readonly options: ElevenLabsLiveOptions,
    private readonly stream: StreamingSpeechOptions,
    private readonly listener: StreamingSpeechListener,
    private readonly keyCheck: LiveKeyCheck,
  ) {
    this.resampler =
      stream.sampleRate > 0 && stream.sampleRate !== RATE
        ? new LinearResampler(stream.sampleRate / RATE)
        : null;
    this.unlink = stream.cancel.onCancel(() => {
      this.close();
    });
    void this.start();
  }

  send(samples: Float32Array): void {
    if (this.done || !this.isOpen || this.finishing || samples.length === 0) return;
    const audio = this.resampler === null ? samples : this.resampler.process(samples);
    if (audio.length > 0) {
      this.buffered.push(audio);
      this.bufferedSamples += audio.length;
    }
    while (this.bufferedSamples >= CHUNK_SAMPLES) {
      // A refused chunk ended the session: the rest is not sent.
      if (!this.sendChunk(this.take(CHUNK_SAMPLES), 'auto')) return;
    }
  }

  finish(): void {
    if (this.done || this.finishing) return;
    if (!this.isOpen) {
      // Nothing was sent, so there is nothing to wait for.
      this.end(null);
      return;
    }
    this.finishing = true;
    this.idle.cancel();
    const rest = this.take(this.bufferedSamples);
    const uncommitted = samplesToMs(this.serverSamples + rest.length) > this.uncommittedFromMs;
    // An empty chunk with `commit: true` is how the SDK commits without audio.
    if (uncommitted && !this.sendChunk(rest, 'force')) return;
    if (this.answeredAll()) {
      this.end(null);
      return;
    }
    const waiting = this.finishWait;
    void this.options.timer.wait(ELEVENLABS_FINISH_TIMEOUT_MS, waiting.signal).then(() => {
      if (waiting.cancelled) return;
      // The engine counts what the last commits would have covered as lost.
      this.end(
        new ApiProviderError(
          this.options.displayName,
          'TimedOut',
          'The last transcript did not arrive in time.',
        ),
      );
    });
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
    const url = elevenLabsRealtimeUrl(
      this.options.baseUrl,
      this.options.model,
      this.stream.language,
    );
    let socket: LiveSocket;
    try {
      socket = (this.options.socket ?? globalLiveSocket)(url, { [ELEVENLABS_API_KEY_HEADER]: key });
    } catch {
      this.explainNeverOpened();
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      try {
        this.onMessage(event.data);
      } catch {
        // A message that cannot be read is not worth the session.
      }
    });
    socket.addEventListener('error', () => {
      // After the start, the close that follows carries the code; before it, nothing else will.
      if (!this.isOpen) this.explainNeverOpened();
    });
    socket.addEventListener('close', (event) => {
      this.onClose(event);
    });
  }

  private onStarted(): void {
    if (this.done) {
      this.closeSocket();
      return;
    }
    if (this.isOpen) return;
    this.isOpen = true;
    this.keyCheck.accept(this.key);
    this.armIdle();
    this.listener.opened();
  }

  /** The first `count` buffered samples as one block, taken out of the buffer. */
  private take(count: number): Float32Array {
    const out = new Float32Array(Math.min(count, this.bufferedSamples));
    let filled = 0;
    while (filled < out.length) {
      const head = this.buffered[0];
      if (head === undefined) break;
      const used = Math.min(head.length, out.length - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(used);
    }
    this.bufferedSamples -= filled;
    return out;
  }

  /**
   * Sends one chunk; `auto` commits it at a quiet point past 20 s or at 25 s, `force` whenever
   * audio is uncommitted. False when the socket refused it and the session ended.
   */
  private sendChunk(samples: Float32Array, mode: CommitMode, silence = false): boolean {
    const startMs = samplesToMs(this.serverSamples);
    const endMs = samplesToMs(this.serverSamples + samples.length);
    const uncommitted = endMs - this.uncommittedFromMs;
    const commit =
      mode === 'force'
        ? uncommitted > 0
        : uncommitted >= ELEVENLABS_FORCED_COMMIT_MS ||
          (uncommitted >= ELEVENLABS_COMMIT_AFTER_MS && rms(samples) < ELEVENLABS_QUIET_RMS);
    const frame = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: base64(float32ToPcm16(samples)),
      commit,
      sample_rate: RATE,
    });
    if (!this.transmit(frame)) return false;
    this.serverSamples += samples.length;
    if (silence) this.silences.push({ atMs: startMs, ms: endMs - startMs });
    if (commit) {
      this.points.push({ startMs: this.uncommittedFromMs, endMs });
      this.uncommittedFromMs = endMs;
    }
    if (!this.finishing) this.armIdle();
    return true;
  }

  /** Restarts the wait after which an idle socket is sent what it holds, or a short silence. */
  private armIdle(): void {
    this.idle.cancel();
    const idle = (this.idle = new CancelSource());
    void this.options.timer.wait(ELEVENLABS_IDLE_SILENCE_MS, idle.signal).then(() => {
      if (idle.cancelled || this.done || this.finishing) return;
      if (this.bufferedSamples > 0) this.sendChunk(this.take(this.bufferedSamples), 'auto');
      else this.sendChunk(new Float32Array(SILENCE_SAMPLES), 'auto', true);
    });
  }

  /** A server time as the engine's: the silence sent on the adapter's own before it is taken out. */
  private engineMs(serverMs: number): number {
    let injected = 0;
    for (const silence of this.silences) {
      if (silence.atMs >= serverMs) break;
      injected += Math.min(silence.ms, serverMs - silence.atMs);
    }
    return Math.round(serverMs - injected);
  }

  /** Sends one frame. A socket that refuses it has dropped: the session ends. False when it did. */
  private transmit(frame: string): boolean {
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
    if (this.done || typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isJsonObject(message)) return;
    const type = message.message_type;
    // An error is worth reading before the start too: it says why the session never started.
    if (isElevenLabsRealtimeError(type)) {
      this.end(this.messageFailure(message));
      return;
    }
    if (type === 'session_started') {
      this.onStarted();
      return;
    }
    if (!this.isOpen) return;
    switch (type) {
      case 'partial_transcript':
        this.onPartial(message);
        return;
      case 'committed_transcript':
        this.onPlainCommit(message);
        return;
      case 'committed_transcript_with_timestamps':
        this.onTimestampedCommit(message);
        return;
      default:
        // Warnings, and whatever the API adds later.
        return;
    }
  }

  /** The text of the uncommitted audio so far: words spread over it. Empty withdraws the last. */
  private onPartial(message: Json): void {
    if (typeof message.text !== 'string') return;
    const said = text(message.text);
    const fromMs = this.engineMs(this.uncommittedFromMs);
    const toMs = this.engineMs(samplesToMs(this.serverSamples));
    this.listener.interim({
      text: said,
      words: spreadWords(said, fromMs, toMs),
      processedMs: toMs,
    });
  }

  /**
   * A plain committed transcript. With timestamps on, the timestamped one of the same commit is
   * the final; the plain one is held until it comes (or dropped when it came first), and given on
   * its own only when it does not, so no text is lost.
   */
  private onPlainCommit(message: Json): void {
    if (this.echoes > 0) {
      this.echoes -= 1;
      return;
    }
    if (this.heldPlain !== null) this.giveHeldPlain();
    this.heldPlain = text(message.text);
    const hold = (this.hold = new CancelSource());
    void this.options.timer.wait(ELEVENLABS_PLAIN_HOLD_MS, hold.signal).then(() => {
      if (hold.cancelled || this.done) return;
      this.giveHeldPlain();
    });
  }

  private giveHeldPlain(): void {
    const said = this.heldPlain;
    if (said === null) return;
    this.heldPlain = null;
    this.hold.cancel();
    const point = this.nextPoint();
    const fromMs = this.engineMs(point.startMs);
    const toMs = this.engineMs(point.endMs);
    this.giveFinal({ text: said, words: spreadWords(said, fromMs, toMs), processedMs: toMs });
  }

  private onTimestampedCommit(message: Json): void {
    if (this.heldPlain !== null) {
      // Its plain twin came first: this one replaces it.
      this.heldPlain = null;
      this.hold.cancel();
    } else {
      this.echoes += 1;
    }
    const point = this.nextPoint();
    let words = elevenLabsWords(message.words);
    const first = words[0];
    if (
      first !== undefined &&
      point.startMs > 0 &&
      first.startMs < point.startMs - ELEVENLABS_SEGMENT_RELATIVE_SLACK_MS
    ) {
      // Counted from the start of the segment: placed on the session clock.
      words = words.map((entry) => ({
        text: entry.text,
        startMs: entry.startMs + point.startMs,
        endMs: entry.endMs + point.startMs,
      }));
    }
    this.giveFinal({
      text: text(message.text),
      words: words.map((entry) => ({
        text: entry.text,
        startMs: this.engineMs(entry.startMs),
        endMs: this.engineMs(entry.endMs),
      })),
      processedMs: this.engineMs(point.endMs),
    });
  }

  /**
   * The commit a committed transcript answers. One the app did not send (the server's own) keeps
   * its text but claims no audio beyond the last answered commit.
   */
  private nextPoint(): CommitPoint {
    const point = this.points.shift() ?? { startMs: this.answeredMs, endMs: this.answeredMs };
    this.answeredMs = Math.max(this.answeredMs, point.endMs);
    return point;
  }

  private giveFinal(result: StreamingSpeechResult): void {
    this.listener.final(result);
    if (this.finishing && this.answeredAll()) this.end(null);
  }

  private answeredAll(): boolean {
    return this.points.length === 0 && this.heldPlain === null;
  }

  private onClose(event: LiveSocketEvent): void {
    if (this.done) return;
    if (!this.isOpen) {
      this.explainNeverOpened();
      return;
    }
    this.end(this.closeFailure(event));
  }

  /**
   * Why the session never started. A refused handshake looks like a dead network (close code
   * 1006, no HTTP status); the key check tells them apart. A key an earlier session of this
   * provider started with is not asked about again.
   */
  private explainNeverOpened(): void {
    if (this.done || this.explaining) return;
    this.explaining = true;
    this.keyCheck.explain(this.key, this.stream.cancel, (failure) => {
      this.end(failure);
    });
  }

  /** The failure of an error message: its type picks the kind, its text is kept without the key. */
  private messageFailure(message: Json): ApiProviderError {
    const said = [message.error, message.message]
      .map(text)
      .filter((part) => part !== '')
      .join(' ');
    return new ApiProviderError(
      this.options.displayName,
      elevenLabsFailureKind(message.message_type),
      scrubSecret(said === '' ? 'The provider reported an error.' : said, this.key),
    );
  }

  /**
   * The failure of a socket that closed after the start: 1011 is the server giving up, 1008 a
   * policy refusal kept with its reason, anything else (an unasked normal close too) a drop.
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
    this.idle.cancel();
    this.hold.cancel();
    this.finishWait.cancel();
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
