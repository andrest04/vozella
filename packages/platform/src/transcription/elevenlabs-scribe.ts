import {
  speechFailureFromHttpStatus,
  type ApiFailureKind,
  type SpeechToTextWord,
} from '@vozella/core';
import { deepgramSeconds, isJsonObject, secondsToMs } from './deepgram-listen';
import { speechLanguageCode } from './openai-speech-to-text-client';

/*
 * What ElevenLabs Scribe shares between its two forms: the upload of a finished piece
 * (`POST /v1/speech-to-text`) and the realtime WebSocket of a live recording. Checked against the
 * docs on 2026-11-26:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert,
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime,
 * https://elevenlabs.io/docs/developers/resources/errors.
 */

/** Without a trailing slash. */
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

/** The header that carries the key, on the upload and on the WebSocket handshake alike. */
export const ELEVENLABS_API_KEY_HEADER = 'xi-api-key';

/** The models of an uploaded piece, the default first. */
export const ELEVENLABS_BATCH_MODELS = ['scribe_v3', 'scribe_v2'] as const;
export type ElevenLabsBatchModel = (typeof ELEVENLABS_BATCH_MODELS)[number];

/** The models of a live stream, in the order of their batch pairs. */
export const ELEVENLABS_LIVE_MODELS = ['scribe_v3_live', 'scribe_v2_realtime'] as const;
export type ElevenLabsLiveModel = (typeof ELEVENLABS_LIVE_MODELS)[number];

export const ELEVENLABS_DEFAULT_BATCH_MODEL: ElevenLabsBatchModel = 'scribe_v3';
export const ELEVENLABS_DEFAULT_LIVE_MODEL: ElevenLabsLiveModel = 'scribe_v3_live';

const LIVE_PAIR: Readonly<Record<ElevenLabsBatchModel, ElevenLabsLiveModel>> = {
  scribe_v3: 'scribe_v3_live',
  scribe_v2: 'scribe_v2_realtime',
};

const isBatchModel = (model: string): model is ElevenLabsBatchModel =>
  (ELEVENLABS_BATCH_MODELS as readonly string[]).includes(model);

/**
 * The live model of the one model setting the user picks, which names the batch model. A value
 * the app no longer offers gets the default live model rather than a stream that cannot open.
 */
export function elevenLabsLiveModel(batchModel: string): ElevenLabsLiveModel {
  const model = batchModel.trim();
  return isBatchModel(model) ? LIVE_PAIR[model] : ELEVENLABS_DEFAULT_LIVE_MODEL;
}

/**
 * The `language_code` as Scribe takes it (ISO-639-1 or -3), from the meeting language as the app
 * holds it: `es-US` is `es`. Null for `auto` or a blank value: the field is then left out and
 * Scribe detects the language itself.
 */
export const elevenLabsLanguageCode = (language: string): string | null =>
  speechLanguageCode(language);

/**
 * The spoken words of a Scribe `words[]`, with times in milliseconds. Scribe also lists the
 * spaces between words (`spacing`) and sounds such as laughter (`audio_event`); neither is a word.
 * The answer is not trusted: an entry without text or a start is dropped, times are never
 * negative, and a word never ends before it starts. Speakers are not read: the app does not ask
 * Scribe to diarize.
 */
export function elevenLabsWords(words: unknown): SpeechToTextWord[] {
  if (!Array.isArray(words)) return [];
  return words.flatMap((entry: unknown): SpeechToTextWord[] => {
    if (!isJsonObject(entry) || entry.type !== 'word') return [];
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    const start = deepgramSeconds(entry.start);
    if (text === '' || start === null) return [];
    const startMs = secondsToMs(start);
    return [
      { text, startMs, endMs: Math.max(startMs, secondsToMs(deepgramSeconds(entry.end) ?? start)) },
    ];
  });
}

/**
 * The failure kind of a realtime error's `message_type`. Only what the user must fix is fatal: the
 * key (`auth_error`), the terms of the account (`unaccepted_terms`) and the credit
 * (`quota_exceeded`). Load and throttling wait out as `RateLimited`. A session past its time
 * limit, one closed for lack of audio, and a failure of the transcriber are worth a new session,
 * so they are `TimedOut`. Input the app got wrong, and anything not named, are `Unknown`, which
 * keeps its text for the log.
 */
export function elevenLabsFailureKind(messageType: unknown): ApiFailureKind {
  switch (typeof messageType === 'string' ? messageType.trim().toLowerCase() : '') {
    case 'auth_error':
    case 'unaccepted_terms':
      return 'KeyInvalid';
    case 'quota_exceeded':
      return 'QuotaExceeded';
    case 'rate_limited':
    case 'commit_throttled':
    case 'queue_overflow':
    case 'resource_exhausted':
      return 'RateLimited';
    case 'session_time_limit_exceeded':
    case 'insufficient_audio_activity':
    case 'transcriber_error':
      return 'TimedOut';
    default:
      return 'Unknown';
  }
}

/**
 * Codes of an HTTP error that mean the credit is spent, whatever the status: the documented
 * `insufficient_credits` (402) and `daily_generation_limit_reached` (429, which waiting a few
 * seconds does not lift), and the legacy `quota_exceeded` status older answers carry.
 */
const CREDIT_SPENT_CODES: readonly string[] = [
  'insufficient_credits',
  'daily_generation_limit_reached',
  'quota_exceeded',
];

/** The `code` and the legacy `status` of an error body: `{"detail":{"code","status",...}}`. */
function detailCodes(bodyText: string): readonly unknown[] {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return [];
  }
  if (!isJsonObject(body) || !isJsonObject(body.detail)) return [];
  return [body.detail.code, body.detail.status];
}

/**
 * The failure kind of a non-2xx answer: `speechFailureFromHttpStatus` (401 and 403 the key, 402
 * the credit, 429 a limit to wait out, 404 the model, 5xx another try), except that a spent
 * credit is `QuotaExceeded` under any status. A 422 is a request the app got wrong: `Unknown`.
 */
export function elevenLabsFailureFromHttpStatus(status: number, bodyText: string): ApiFailureKind {
  const spent = detailCodes(bodyText).some(
    (code) => typeof code === 'string' && CREDIT_SPENT_CODES.includes(code),
  );
  return spent ? 'QuotaExceeded' : speechFailureFromHttpStatus(status, bodyText);
}
