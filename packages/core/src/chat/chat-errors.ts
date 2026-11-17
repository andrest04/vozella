import type { TranslateFn } from '../i18n/translator';
import { formatFailure } from '../summaries/cli-failure-messages';

export { isCancellation } from '../summaries/provider';

/** Why a send produced no answer. The cancelled send has no kind: it is silent. */
export type ChatFailureKind =
  | 'setup-cancelled'
  | 'empty-answer'
  | 'send-failed'
  | 'provider-removed'
  /** The meeting of the thread was deleted or its Live take ended: the thread is read-only. */
  | 'scope-gone';

export interface ChatFailure {
  readonly kind: ChatFailureKind;
  /** The sentence to show, already in the language of the translator. */
  readonly message: string;
}

/** `Status_SetupCancelled` has no "Could not answer" prefix. */
export function setupCancelledFailure(t: TranslateFn): ChatFailure {
  return { kind: 'setup-cancelled', message: t('Status_SetupCancelled') };
}

export function emptyAnswerFailure(t: TranslateFn): ChatFailure {
  return { kind: 'empty-answer', message: t('Chat_EmptyAnswer') };
}

/** xAI is gone: a settings file that still selects it asks the user to pick another provider. */
export function providerRemovedFailure(t: TranslateFn): ChatFailure {
  return { kind: 'provider-removed', message: t('Ui_SummaryProviderXaiRemoved') };
}

/**
 * A thread whose meeting is gone, or whose Live take ended, cannot take a new question. There is
 * no string of its own yet, so the sentence is the usual "could not answer" with the meeting that
 * was not found; the page shows its own line by `kind`.
 */
export function scopeGoneFailure(t: TranslateFn): ChatFailure {
  return { kind: 'scope-gone', message: t('Chat_SendFailed', t('ChatMeetingNotFound')) };
}

/**
 * The detail comes from the shared mapper, never from the raw error. A CLI failure, a local
 * budget failure (`PromptTooLong`) and a plain error all end up as `Chat_SendFailed` plus a
 * mapped sentence in the right language.
 */
export function sendFailedFailure(error: unknown, t: TranslateFn): ChatFailure {
  return { kind: 'send-failed', message: t('Chat_SendFailed', formatFailure(error, t)) };
}
