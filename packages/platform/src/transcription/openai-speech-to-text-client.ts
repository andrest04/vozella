import {
  ApiProviderError,
  CLOUD_TRANSCRIPTION_MAX_FILE_BYTES,
  cloudTranscriptionApiEngine,
  encodePcm16Wav,
  resolveCloudTranscriptionModel,
  throwIfCancelled,
  type ApiKeyStore,
  type AppSettings,
  type CancelSignal,
  type CloudTranscriptionKind,
  type SpeechToTextClient,
  type SpeechToTextRequest,
  type SpeechToTextResult,
  type SpeechToTextWord,
} from '@vozella/core';
import { apiJson, globalFetch } from '../api-providers/api-http';

/**
 * Two minutes without a byte. A piece is at most about a minute of audio and the answer arrives
 * whole, so this is far above a healthy call and well below the five minutes of a chat answer.
 */
export const SPEECH_TO_TEXT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The most prompt text sent. The endpoint takes at most 224 tokens of prompt; 400 characters stay
 * under that for any language the app offers without counting tokens here.
 */
export const SPEECH_PROMPT_MAX_CHARS = 400;

export interface OpenAiSpeechToTextOptions {
  /** The provider name in errors. */
  readonly displayName: string;
  /** Without a trailing slash. */
  readonly baseUrl: string;
  readonly model: string;
  /** Read for every piece, so a key saved in Settings is used by the next one. */
  readonly apiKey: () => Promise<string | null>;
  /** Tests replace it; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Tests lower it; production uses the providers' 25 MB. */
  readonly maxFileBytes?: number;
}

/**
 * The language as the endpoint takes it: a bare ISO-639-1 code. A region (`es-US`) is dropped;
 * `auto` and a blank value give null, which sends no language so the model detects it.
 */
export function speechLanguageCode(language: string): string | null {
  const code = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return code === '' || code === 'auto' ? null : code;
}

/**
 * The prompt as sent: the end of the text before this piece, because the latest words matter most,
 * cut at a word so the model never sees half of one. Null when there is nothing to send.
 */
export function speechPromptTail(prompt: string | null | undefined): string | null {
  const text = prompt?.trim() ?? '';
  if (text === '') return null;
  if (text.length <= SPEECH_PROMPT_MAX_CHARS) return text;
  const cutAt = text.length - SPEECH_PROMPT_MAX_CHARS;
  const tail = text.slice(cutAt);
  const midWord = /\S/.test(text.charAt(cutAt - 1)) && /^\S/.test(tail);
  const whole = (midWord ? tail.replace(/^\S+/, '') : tail).trimStart();
  // One word longer than the limit has no boundary to cut at: its end is still better than nothing.
  return whole === '' ? tail : whole;
}

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objects = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.filter(isObject) : [];

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toMs = (value: number): number => Math.max(0, Math.round(value * 1000));

const wordsOf = (text: unknown): string[] =>
  typeof text === 'string' ? text.split(/\s+/).filter((word) => word !== '') : [];

/** Words of `texts` spread evenly from `startMs` to `endMs`: timing when the answer has none finer. */
function spread(texts: readonly string[], startMs: number, endMs: number): SpeechToTextWord[] {
  const step = Math.max(0, endMs - startMs) / Math.max(1, texts.length);
  return texts.map((text, index) => ({
    text,
    startMs: Math.round(startMs + index * step),
    endMs: Math.round(startMs + (index + 1) * step),
  }));
}

/**
 * The words of a `verbose_json` answer. Whether `word` carries spaces is not documented, so each is
 * trimmed and empty ones are dropped. When the answer has no `words[]` (a model without word
 * timestamps) the words of each segment are spread evenly over that segment; with no segments
 * either, the words of the text are spread over the whole piece. Times are never negative and a
 * word never ends before it starts.
 */
function readWords(answer: Json, text: string, durationMs: number): SpeechToTextWord[] {
  const timed = objects(answer.words).flatMap((entry): SpeechToTextWord[] => {
    const word = typeof entry.word === 'string' ? entry.word.trim() : '';
    const start = seconds(entry.start);
    if (word === '' || start === null) return [];
    const startMs = toMs(start);
    return [{ text: word, startMs, endMs: Math.max(startMs, toMs(seconds(entry.end) ?? start)) }];
  });
  if (timed.length > 0) return timed;

  const fromSegments = objects(answer.segments).flatMap((segment) => {
    const start = seconds(segment.start);
    const end = seconds(segment.end);
    if (start === null || end === null) return [];
    return spread(wordsOf(segment.text), toMs(start), toMs(end));
  });
  return fromSegments.length > 0 ? fromSegments : spread(wordsOf(text), 0, durationMs);
}

/**
 * Adapter: the OpenAI-compatible `POST {baseUrl}/audio/transcriptions`, which Groq and OpenAI both
 * serve. It uploads one piece as a 16-bit mono WAV and asks for `verbose_json` with word
 * timestamps. Only the documented fields both providers share are sent. Docs (checked 2026-11-15):
 * console.groq.com/docs/speech-to-text, console.groq.com/docs/errors,
 * console.groq.com/docs/rate-limits, platform.openai.com/docs/api-reference/audio/createTranscription.
 */
export class OpenAiSpeechToTextClient implements SpeechToTextClient {
  constructor(private readonly options: OpenAiSpeechToTextOptions) {}

  async transcribe(
    request: SpeechToTextRequest,
    cancel: CancelSignal,
  ): Promise<SpeechToTextResult> {
    const { displayName } = this.options;
    throwIfCancelled(cancel);
    const apiKey = (await this.options.apiKey())?.trim() ?? '';
    if (apiKey === '') throw new ApiProviderError(displayName, 'KeyMissing');

    const wav = encodePcm16Wav(request.samples, request.sampleRate);
    if (wav.length > (this.options.maxFileBytes ?? CLOUD_TRANSCRIPTION_MAX_FILE_BYTES)) {
      // The server would answer 413; the audio never leaves the device for nothing.
      throw new ApiProviderError(displayName, 'Unknown', 'The audio piece is too large to upload.');
    }

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.options.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');
    const language = speechLanguageCode(request.language);
    if (language !== null) form.append('language', language);
    const prompt = speechPromptTail(request.prompt);
    if (prompt !== null) form.append('prompt', prompt);

    const answer = await apiJson(
      {
        url: `${this.options.baseUrl}/audio/transcriptions`,
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        form,
      },
      {
        fetch: this.options.fetch ?? globalFetch,
        timeoutMs: this.options.timeoutMs ?? SPEECH_TO_TEXT_TIMEOUT_MS,
        cancel,
        displayName,
        secret: apiKey,
      },
    );
    if (!isObject(answer)) {
      throw new ApiProviderError(displayName, 'Unknown', 'The answer was not a transcription.');
    }

    const measured = seconds(answer.duration);
    const durationMs =
      measured === null
        ? Math.round((request.samples.length * 1000) / request.sampleRate)
        : toMs(measured);
    const said = typeof answer.text === 'string' ? answer.text.trim() : '';
    const words = readWords(answer, said, durationMs);
    // Silence is an answer, not a failure: empty text and no words.
    return {
      text: said === '' ? words.map((word) => word.text).join(' ') : said,
      words,
      durationMs,
    };
  }
}

export interface CloudSpeechToTextDeps {
  readonly keys: Pick<ApiKeyStore, 'get'>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface CloudSpeechToTextChoice {
  readonly kind: CloudTranscriptionKind;
  readonly settings: AppSettings;
  /** The saved transcription model; null or blank uses the provider's default. */
  readonly model?: string | null;
}

/**
 * The `SpeechToTextClient` of a cloud transcription engine: the endpoint, name and key of its API
 * engine, the chosen model, and the adapter of its protocol (one today). The key is the one saved
 * for that API kind; a missing key fails with `KeyMissing` before any request.
 */
export function createCloudSpeechToTextClient(
  deps: CloudSpeechToTextDeps,
  choice: CloudSpeechToTextChoice,
): SpeechToTextClient {
  const engine = cloudTranscriptionApiEngine(choice.kind);
  const baseUrl = engine.resolveBaseUrl(choice.settings);
  if (baseUrl === null) {
    throw new ApiProviderError(engine.displayName, 'Unknown', 'No base URL is set.');
  }
  return new OpenAiSpeechToTextClient({
    displayName: engine.displayName,
    baseUrl,
    model: resolveCloudTranscriptionModel(choice.kind, choice.model),
    apiKey: () => deps.keys.get(choice.kind),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
}
