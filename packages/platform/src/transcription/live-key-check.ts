import { ApiProviderError, isApiProviderError, type CancelSignal } from '@vozella/core';

/**
 * Asks the provider over HTTP whether it accepts the key: resolves when it does, rejects with the
 * `ApiProviderError` of the answer when it does not or cannot be reached.
 */
export type LiveKeyCheckRequest = (key: string, cancel: CancelSignal) => Promise<void>;

/**
 * Why a live session never opened, for every streaming provider. The socket says only that it
 * failed (close code 1006, no HTTP status), which a refused key and a dead network both look like;
 * the provider's key check tells them apart. One instance lives as long as its provider: the
 * streaming engine opens a new session after a drop, and while the network is down each of them
 * fails to open. With a key a session of this provider already opened with, that is a connection
 * failure at once and the key check is not sent again.
 */
export class LiveKeyCheck {
  /** The key a session of the provider opened with. */
  private accepted: string | null = null;

  constructor(
    private readonly displayName: string,
    private readonly request: LiveKeyCheckRequest,
  ) {}

  /** A session opened with this key: the provider took it. */
  accept(key: string): void {
    this.accepted = key;
  }

  /**
   * Gives `end` the failure of a session that never opened, once: the provider's own refusal of
   * the key, else a connection failure (an accepted key, an unreachable provider, or anything the
   * check throws that is not a provider failure). A known key is told at once, without asking.
   */
  explain(key: string, cancel: CancelSignal, end: (failure: ApiProviderError) => void): void {
    if (key !== '' && this.accepted === key) {
      end(new ApiProviderError(this.displayName, 'Network'));
      return;
    }
    void this.ask(key, cancel).then(end);
  }

  private async ask(key: string, cancel: CancelSignal): Promise<ApiProviderError> {
    try {
      await this.request(key, cancel);
      return new ApiProviderError(this.displayName, 'Network');
    } catch (error) {
      return isApiProviderError(error) ? error : new ApiProviderError(this.displayName, 'Network');
    }
  }
}
