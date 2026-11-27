import {
  ApiProviderError,
  encodePcm16Wav,
  throwIfCancelled,
  type CancelSignal,
  type SpeechToTextClient,
  type SpeechToTextRequest,
  type SpeechToTextResult,
} from '@vozella/core';
import { apiJson, globalFetch } from '../api-providers/api-http';
import { deepgramSeconds, isJsonObject, secondsToMs } from './deepgram-listen';
import {
  ELEVENLABS_API_KEY_HEADER,
  elevenLabsFailureFromHttpStatus,
  elevenLabsLanguageCode,
  elevenLabsWords,
} from './elevenlabs-scribe';
import { SPEECH_TO_TEXT_TIMEOUT_MS } from './openai-speech-to-text-client';

export interface ElevenLabsSpeechToTextOptions {
  /** The provider name in errors. */
  readonly displayName: string;
  /** Without a trailing slash. */
  readonly baseUrl: string;
  /** A batch model, such as `scribe_v3`. */
  readonly model: string;
  /** Read for every piece, so a key saved in Settings is used by the next one. */
  readonly apiKey: () => Promise<string | null>;
  /** Tests replace it; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Adapter: ElevenLabs Scribe's `POST {baseUrl}/speech-to-text`, for the pass after Stop and
 * imported files. It uploads one piece as a 16-bit mono WAV in a multipart form and asks for word
 * timestamps, without diarization or audio-event tags, so the text holds only what was said. The
 * prompt of the request is not sent: the endpoint has no field for the text that came before. A
 * piece is at most about a minute, far under the endpoint's limit, so no size is checked here.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert (checked 2026-11-26).
 */
export class ElevenLabsSpeechToTextClient implements SpeechToTextClient {
  constructor(private readonly options: ElevenLabsSpeechToTextOptions) {}

  async transcribe(
    request: SpeechToTextRequest,
    cancel: CancelSignal,
  ): Promise<SpeechToTextResult> {
    const { displayName, baseUrl, model } = this.options;
    throwIfCancelled(cancel);
    const apiKey = (await this.options.apiKey())?.trim() ?? '';
    if (apiKey === '') throw new ApiProviderError(displayName, 'KeyMissing');

    const wav = encodePcm16Wav(request.samples, request.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model_id', model);
    form.append('timestamps_granularity', 'word');
    form.append('diarize', 'false');
    form.append('tag_audio_events', 'false');
    const language = elevenLabsLanguageCode(request.language);
    if (language !== null) form.append('language_code', language);

    const answer = await apiJson(
      {
        url: `${baseUrl}/speech-to-text`,
        method: 'POST',
        headers: { [ELEVENLABS_API_KEY_HEADER]: apiKey },
        form,
      },
      {
        fetch: this.options.fetch ?? globalFetch,
        timeoutMs: this.options.timeoutMs ?? SPEECH_TO_TEXT_TIMEOUT_MS,
        cancel,
        displayName,
        secret: apiKey,
        classify: elevenLabsFailureFromHttpStatus,
      },
    );
    // A webhook acknowledgement or any other shape carries neither field.
    if (!isJsonObject(answer) || (typeof answer.text !== 'string' && !Array.isArray(answer.words))) {
      throw new ApiProviderError(displayName, 'Unknown', 'The answer was not a transcription.');
    }

    const measured = deepgramSeconds(answer.audio_duration_secs);
    const words = elevenLabsWords(answer.words);
    const said = typeof answer.text === 'string' ? answer.text.trim() : '';
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
