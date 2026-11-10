import { isCliProvider, type SummaryProviderKind } from '../library/settings';

/**
 * Only the two CLI providers can search the web. Local and the API key engines ignore the flag
 * (web search stays CLI-only; xAI is gone).
 */
export function supportsWebSearch(kind: SummaryProviderKind): boolean {
  return isCliProvider(kind);
}

/**
 * The typed question searches the web only when the provider can and the user switched it on. The
 * automatic needs-web verdict was dropped (owner decision 2026-11-03, may return later).
 */
export function shouldUseWeb(providerSupportsWeb: boolean, forced: boolean): boolean {
  return providerSupportsWeb && forced;
}
