/**
 * The API key engines (BYOK) as the channels name them: the saved summary-provider `kind` and the
 * chat and summaries `id`, in the order the app offers them. Every schema that lists API engines
 * derives from this table.
 *
 * It restates the kinds and ids of core's `API_ENGINES` table: contracts depends on zod only, so
 * it cannot import core. `api-provider-edit-points.test.ts` (apps/desktop) compares the two and
 * fails naming the engine that is missing or extra here.
 */
const API_PROVIDERS = [
  { kind: 'OpenAi', id: 'openai' },
  { kind: 'Anthropic', id: 'anthropic' },
  { kind: 'Gemini', id: 'gemini' },
  { kind: 'Groq', id: 'groq' },
  { kind: 'OpenAiCompatible', id: 'openai-compatible' },
] as const;

export const API_PROVIDER_KINDS = API_PROVIDERS.map((provider) => provider.kind);
export const API_PROVIDER_IDS = API_PROVIDERS.map((provider) => provider.id);

/**
 * The providers that only transcribe, with the user's own key. They are not API engines: no
 * summary, chat or setup schema lists them. It restates the kinds of core's
 * `TRANSCRIPTION_PROVIDERS` table, and the same test compares the two.
 */
export const TRANSCRIPTION_PROVIDER_KINDS = ['Deepgram'] as const;
