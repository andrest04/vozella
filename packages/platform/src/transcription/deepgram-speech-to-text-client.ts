import {
  ApiProviderError,
  encodePcm16Wav,
  speechFailureFromHttpStatus,
  throwIfCancelled,
  type CancelSignal,
  type SpeechToTextClient,
  type SpeechToTextRequest,
  type SpeechToTextResult,
} from '@vozella/core';
import { apiJson, globalFetch } from '../api-providers/api-http';
import {
  deepgramListenQuery,
  deepgramSeconds,
  deepgramWords,
  isJsonObject,
  secondsToMs,
  type Json,
} from './deepgram-listen';
import { SPEECH_TO_TEXT_TIMEOUT_MS } from './openai-speech-to-text-client';

export interface DeepgramSpeechToTextOptions {
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
}

const firstObject = (value: unknown): Json | null => {
  const first: unknown = Array.isArray(value) ? value[0] : undefined;
  return isJsonObject(first) ? first : null;
};

/**
 * Adapter: Deepgram's prerecorded `POST {baseUrl}/listen`, for the pass after Stop and imported
 * files. It uploads one piece as a 16-bit mono WAV, the whole body of the request, and reads the
 * first alternative of the first channel. The prompt of the request is not sent: the endpoint has
 * no parameter for the text that came before. A piece is at most about a minute, far under the
 * endpoint's 2 GB, so no size is checked here.
 */
export class DeepgramSpeechToTextClient implements SpeechToTextClient {
  constructor(private readonly options: DeepgramSpeechToTextOptions) {}

  async transcribe(
    request: SpeechToTextRequest,
    cancel: CancelSignal,
  ): Promise<SpeechToTextResult> {
    const { displayName, baseUrl, model } = this.options;
    throwIfCancelled(cancel);
    const apiKey = (await this.options.apiKey())?.trim() ?? '';
    if (apiKey === '') throw new ApiProviderError(displayName, 'KeyMissing');

    const answer = await apiJson(
      {
        url: `${baseUrl}/listen?${deepgramListenQuery({ model, language: request.language })}`,
        method: 'POST',
        headers: { authorization: `Token ${apiKey}` },
        bytes: {
          data: encodePcm16Wav(request.samples, request.sampleRate),
          contentType: 'audio/wav',
        },
      },
      {
        fetch: this.options.fetch ?? globalFetch,
        timeoutMs: this.options.timeoutMs ?? SPEECH_TO_TEXT_TIMEOUT_MS,
        cancel,
        displayName,
        secret: apiKey,
        // 401 and 403 are the key, 402 the funds, 429 a limit to wait out, 5xx worth another try.
        classify: speechFailureFromHttpStatus,
      },
    );
    const results = isJsonObject(answer) && isJsonObject(answer.results) ? answer.results : null;
    const alternative = firstObject(firstObject(results?.channels)?.alternatives);
    if (!isJsonObject(answer) || alternative === null) {
      throw new ApiProviderError(displayName, 'Unknown', 'The answer was not a transcription.');
    }

    const measured = isJsonObject(answer.metadata)
      ? deepgramSeconds(answer.metadata.duration)
      : null;
    const words = deepgramWords(alternative.words);
    const said = typeof alternative.transcript === 'string' ? alternative.transcript.trim() : '';
    // Silence is an answer, not a failure: empty text and no words.
    return {
      text: said === '' ? words.map((word) => word.text).join(' ') : said,
      words,
      durationMs:
        measured === null
          ? Math.round((request.samples.length * 1000) / request.sampleRate)
          : secondsToMs(measured),
    };
  }
}
