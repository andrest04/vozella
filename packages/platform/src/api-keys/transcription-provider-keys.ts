import {
  API_FAILURE_UI_KEYS,
  API_KEY_SETTINGS_UI_KEYS,
  ApiProviderError,
  isApiProviderError,
  TRANSCRIPTION_PROVIDERS,
  type ApiFailureKind,
  type ApiKeyStore,
  type CancelSignal,
  type TranscriptionProvider,
  type TranscriptionProviderKind,
} from '@vozella/core';
import { apiBody, globalFetch } from '../api-providers/api-http';
import { elevenLabsFailureFromHttpStatus } from '../transcription/elevenlabs-scribe';

/** How long Verify waits for the provider before it says it took too long. */
export const TRANSCRIPTION_KEY_VERIFY_TIMEOUT_MS = 20_000;

export interface VerifyTranscriptionKeyOptions {
  readonly cancel?: CancelSignal;
  /** Defaults to `TRANSCRIPTION_KEY_VERIFY_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * How a refusal of the key check reads, where a provider's answer needs more than its status:
 * ElevenLabs says a spent credit with its own codes, under 401 too. Every other provider maps like
 * any API call.
 */
const KEY_CHECK_FAILURES: Partial<
  Record<TranscriptionProviderKind, (status: number, bodyText: string) => ApiFailureKind>
> = {
  ElevenLabs: elevenLabsFailureFromHttpStatus,
};

/**
 * Asks a transcription-only provider whether it accepts a key, with the request its table row
 * declares (`keyCheck`). It sends no audio and reads nothing from the answer: any 2xx means the
 * key is accepted. A failure maps like every other API call (KeyInvalid, QuotaExceeded,
 * RateLimited, Network...), so the same localized text explains it, and never carries the key.
 */
export async function verifyTranscriptionProviderKey(
  provider: TranscriptionProvider,
  key: string | null,
  fetchImpl: typeof fetch = globalFetch,
  options: VerifyTranscriptionKeyOptions = {},
): Promise<void> {
  const secret = key?.trim() ?? '';
  if (secret === '') throw new ApiProviderError(provider.displayName, 'KeyMissing');
  const { keyCheck } = provider;
  const classify = KEY_CHECK_FAILURES[provider.kind];
  const answer = apiBody(
    {
      url: `${provider.defaultBaseUrl}${keyCheck.path}`,
      method: keyCheck.method,
      headers: {
        [keyCheck.header]:
          keyCheck.authScheme === null ? secret : `${keyCheck.authScheme} ${secret}`,
      },
    },
    {
      fetch: fetchImpl,
      ...(classify ? { classify } : {}),
      timeoutMs: options.timeoutMs ?? TRANSCRIPTION_KEY_VERIFY_TIMEOUT_MS,
      ...(options.cancel ? { cancel: options.cancel } : {}),
      displayName: provider.displayName,
      secret,
    },
  );
  // The body is read to its end so the connection closes cleanly; what it says is not needed.
  let step = await answer.next();
  while (step.done !== true) step = await answer.next();
}

/** What a key change did. The key itself is never part of an answer. */
export type TranscriptionKeyOutcome =
  | { readonly status: 'saved'; readonly keySet: boolean }
  | { readonly status: 'failed'; readonly errorKey: string };

export type TranscriptionKeyVerifyOutcome =
  { readonly status: 'verified' } | { readonly status: 'failed'; readonly errorKey: string };

export interface TranscriptionProviderKeysDeps {
  /** The app's one key store. Without it no key can be saved. */
  readonly keys: ApiKeyStore | undefined;
  /** The HTTP client Verify uses. A fake in tests and in the fake native build. */
  readonly fetch?: typeof fetch;
  /** Defaults to `TRANSCRIPTION_KEY_VERIFY_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

const STORE_UNAVAILABLE = API_KEY_SETTINGS_UI_KEYS.storeUnavailable;

/**
 * The key commands of the providers that only transcribe: save, remove, and Verify. It is the
 * counterpart of the Settings commands for the API engines' keys, for the kinds that are not API
 * engines. Keys go into the store and never come back out of this class; answers carry a flag or
 * the catalog key of the reason.
 */
export class TranscriptionProviderKeys {
  constructor(private readonly deps: TranscriptionProviderKeysDeps) {}

  async set(kind: TranscriptionProviderKind, key: string): Promise<TranscriptionKeyOutcome> {
    const { keys } = this.deps;
    if (!keys) return { status: 'failed', errorKey: STORE_UNAVAILABLE };
    try {
      await keys.set(kind, key);
      return { status: 'saved', keySet: await keys.has(kind) };
    } catch {
      // The adapter's message is not shown; it may say why encryption failed, never the key.
      return { status: 'failed', errorKey: STORE_UNAVAILABLE };
    }
  }

  async clear(kind: TranscriptionProviderKind): Promise<TranscriptionKeyOutcome> {
    const { keys } = this.deps;
    if (!keys) return { status: 'saved', keySet: false };
    try {
      await keys.delete(kind);
      return { status: 'saved', keySet: await keys.has(kind) };
    } catch {
      return { status: 'failed', errorKey: STORE_UNAVAILABLE };
    }
  }

  async verify(kind: TranscriptionProviderKind): Promise<TranscriptionKeyVerifyOutcome> {
    try {
      const key = (await this.deps.keys?.get(kind)) ?? null;
      await verifyTranscriptionProviderKey(TRANSCRIPTION_PROVIDERS[kind], key, this.deps.fetch, {
        timeoutMs: this.deps.timeoutMs ?? TRANSCRIPTION_KEY_VERIFY_TIMEOUT_MS,
      });
      return { status: 'verified' };
    } catch (error) {
      const failure = isApiProviderError(error) ? error.kind : 'Unknown';
      return { status: 'failed', errorKey: API_FAILURE_UI_KEYS[failure] };
    }
  }
}
