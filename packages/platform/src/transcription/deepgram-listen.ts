import type { ApiFailureKind, SpeechToTextWord } from '@vozella/core';

/*
 * What Deepgram's `/listen` shares between its two forms: the WebSocket of a live recording and
 * the POST of a finished file. Docs and the observed answers are in
 * odd/tasks/deepgram-streaming-transcription.md (checked 2026-11-15).
 */

/** The `endpointing` Deepgram recommends for the multilingual model, in milliseconds. */
export const DEEPGRAM_MULTILINGUAL_ENDPOINTING_MS = 100;

export interface DeepgramLanguage {
  /** The `language` parameter. */
  readonly language: string;
  /** The `endpointing` parameter of a live stream; null leaves the provider's default. */
  readonly endpointingMs: number | null;
}

/**
 * The language as `/listen` takes it, from the meeting language as the app holds it (a code, an
 * engine locale such as `es-US`, or `auto`). Spanish and English are asked for by name, which is
 * cheaper and more accurate than detecting them. The app's Spanish locale is `es-US`, used for
 * every Spanish speaker, so it is plain `es`; only the explicit `es-419` tag asks for Latin
 * American Spanish. Everything else, `auto` included, goes to `multi`, the model that follows a
 * conversation across languages, with the short endpointing its docs recommend.
 */
export function deepgramLanguage(language: string): DeepgramLanguage {
  const tag = language.trim().toLowerCase().replace('_', '-');
  if (tag === 'es-419') return { language: 'es-419', endpointingMs: null };
  const code = tag.split('-')[0] ?? '';
  if (code === 'es' || code === 'en') return { language: code, endpointingMs: null };
  return { language: 'multi', endpointingMs: DEEPGRAM_MULTILINGUAL_ENDPOINTING_MS };
}

export interface DeepgramListenRequest {
  readonly model: string;
  /** The meeting language as the app holds it. */
  readonly language: string;
  /** Present for a live stream of raw 16-bit mono PCM; absent for an uploaded file. */
  readonly live?: { readonly sampleRate: number };
}

/** The query string of a `/listen` request, without the question mark. */
export function deepgramListenQuery(request: DeepgramListenRequest): string {
  const { language, endpointingMs } = deepgramLanguage(request.language);
  const query = new URLSearchParams({
    model: request.model,
    punctuate: 'true',
    smart_format: 'true',
    language,
  });
  if (request.live !== undefined) {
    query.set('encoding', 'linear16');
    query.set('sample_rate', String(Math.round(request.live.sampleRate)));
    query.set('channels', '1');
    query.set('interim_results', 'true');
    if (endpointingMs !== null) query.set('endpointing', String(endpointingMs));
  }
  return query.toString();
}

export type Json = Readonly<Record<string, unknown>>;

export const isJsonObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A count of seconds from the wire; null for anything that is not a finite number. */
export const deepgramSeconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const secondsToMs = (value: number): number => Math.max(0, Math.round(value * 1000));

/**
 * The words of an alternative: `punctuated_word` when present, else `word`, with times in
 * milliseconds on the clock the answer uses (the start of the file, or of the stream). The answer
 * is not trusted: an entry without text or a start is dropped, times are never negative, and a
 * word never ends before it starts.
 */
export function deepgramWords(words: unknown): SpeechToTextWord[] {
  if (!Array.isArray(words)) return [];
  return words.flatMap((entry: unknown): SpeechToTextWord[] => {
    if (!isJsonObject(entry)) return [];
    const punctuated = typeof entry.punctuated_word === 'string' ? entry.punctuated_word : '';
    const bare = typeof entry.word === 'string' ? entry.word : '';
    const text = (punctuated.trim() === '' ? bare : punctuated).trim();
    const start = deepgramSeconds(entry.start);
    if (text === '' || start === null) return [];
    const startMs = secondsToMs(start);
    return [
      { text, startMs, endMs: Math.max(startMs, secondsToMs(deepgramSeconds(entry.end) ?? start)) },
    ];
  });
}

/**
 * The failure kind of a Deepgram error code, as an `Error` message of a stream or the reason of a
 * closed socket carries it. Only the documented codes are named; anything else is `Unknown`, which
 * keeps its text for the log.
 */
export function deepgramFailureKind(code: unknown): ApiFailureKind {
  switch (typeof code === 'string' ? code.trim().toUpperCase() : '') {
    case 'INVALID_AUTH':
    case 'INSUFFICIENT_PERMISSIONS':
      return 'KeyInvalid';
    case 'ASR_PAYMENT_REQUIRED':
      return 'QuotaExceeded';
    case 'TOO_MANY_REQUESTS':
      return 'RateLimited';
    // The stream got no audio and no KeepAlive for ten seconds.
    case 'NET-0001':
      return 'TimedOut';
    default:
      return 'Unknown';
  }
}
