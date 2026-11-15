import type { ApiKeyKindDto } from '@vozella/contracts';
import { CircleAlert, CircleCheck, Eye, EyeOff } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, Icon, IconButton, Input } from '../../ui';
import { KEY_PROVIDER_NAME_KEYS } from './api-engines';

/** Shown in the empty key field once a key is saved. A mask, never the key or any part of it. */
const SAVED_KEY_MASK = '•'.repeat(16);

/** What a key change or a Verify answered, already in words for the status line under the key. */
export type ApiKeyAnswer =
  | { readonly status: 'saved'; readonly keySet: boolean }
  | { readonly status: 'verified'; readonly models: readonly string[] }
  | { readonly status: 'failed'; readonly errorKey: string };

/**
 * The three things the key row asks of the Settings page. The key goes to main once, on Save. The
 * kind is an API engine or a provider that only transcribes: the page sends each to its channel.
 */
export interface ApiKeyActions {
  readonly setApiKey: (kind: ApiKeyKindDto, key: string) => Promise<ApiKeyAnswer>;
  readonly clearApiKey: (kind: ApiKeyKindDto) => Promise<ApiKeyAnswer>;
  /** Asks the provider about the saved key; an API engine also lists its models. Changes nothing. */
  readonly verifyApiKey: (kind: ApiKeyKindDto) => Promise<ApiKeyAnswer>;
}

/** The status line under a control: one sentence, announced politely, ink only (no status colors). */
export type FieldStatus = { readonly tone: 'done' | 'problem'; readonly text: string } | null;

/** One setting stacked: words above, controls below, so a row of controls has the full width. */
export function StackedRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: (ids: { titleId: string; descriptionId: string }) => ReactNode;
}): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="flex flex-col gap-2.5 border-b border-hairline py-3.5 last:border-b-0"
    >
      <div className="flex flex-col gap-0.5">
        <span id={titleId} className="text-ui-lg font-medium text-ink">
          {title}
        </span>
        <span id={descriptionId} className="max-w-prose text-ui text-ink-muted">
          {description}
        </span>
      </div>
      {children({ titleId, descriptionId })}
    </div>
  );
}

export function StatusLine({
  status,
  testId,
}: {
  readonly status: FieldStatus;
  readonly testId: string;
}) {
  return (
    <p aria-live="polite" data-testid={testId} className="text-ui text-ink empty:hidden">
      {status ? (
        <span className="flex gap-1.5">
          <Icon
            icon={status.tone === 'done' ? CircleCheck : CircleAlert}
            size={14}
            className="mt-[3px] shrink-0"
          />
          <span>{status.text}</span>
        </span>
      ) : null}
    </p>
  );
}

/**
 * The API key of one provider (BYOK): the field, Save, Verify and Remove, with the status line
 * under them. One key per provider serves every feature that uses that provider, so every place
 * that asks for the key draws this row. The key goes to main once on Save and is never read back;
 * the field then shows a mask.
 */
export function ApiKeyField({
  kind,
  keySet,
  optional = false,
  actions,
  onVerified,
  verifiedText,
  footnote,
}: {
  readonly kind: ApiKeyKindDto;
  /** A key is saved for this provider. */
  readonly keySet: boolean;
  /** The provider works without a key (a local OpenAI-compatible server). */
  readonly optional?: boolean;
  readonly actions: ApiKeyActions;
  /** The models a Verify listed; an empty list after the key was removed. */
  readonly onVerified?: (models: readonly string[]) => void;
  /** The sentence after a Verify that passed. The default points at the model list. */
  readonly verifiedText?: (models: readonly string[]) => string;
  /** One quiet line under the row, for what this key is also used for. */
  readonly footnote?: string;
}): ReactNode {
  const t = useT();
  const name = t(KEY_PROVIDER_NAME_KEYS[kind]);
  const [keyDraft, setKeyDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | 'verify' | null>(null);
  const [status, setStatus] = useState<FieldStatus>(null);

  const problem = (answer: Extract<ApiKeyAnswer, { status: 'failed' }>): FieldStatus => ({
    tone: 'problem',
    text: t(answer.errorKey as StringKey, name),
  });

  const saveKey = async (): Promise<void> => {
    if (keyDraft.trim() === '' || busy) return;
    setBusy('save');
    const answer = await actions.setApiKey(kind, keyDraft);
    setBusy(null);
    if (answer.status === 'failed') {
      setStatus(problem(answer));
      return;
    }
    setKeyDraft('');
    setRevealed(false);
    setStatus({ tone: 'done', text: t('Ui_ApiKeySavedAnnounce') });
  };

  const removeKey = async (): Promise<void> => {
    if (busy) return;
    setBusy('remove');
    const answer = await actions.clearApiKey(kind);
    setBusy(null);
    onVerified?.([]);
    setStatus(
      answer.status === 'failed'
        ? problem(answer)
        : { tone: 'done', text: t('Ui_ApiKeyRemovedAnnounce') },
    );
  };

  const verify = async (): Promise<void> => {
    if (busy) return;
    setBusy('verify');
    setStatus(null);
    const answer = await actions.verifyApiKey(kind);
    setBusy(null);
    if (answer.status === 'failed') {
      setStatus(problem(answer));
      return;
    }
    if (answer.status !== 'verified') return;
    onVerified?.(answer.models);
    setStatus({
      tone: 'done',
      text: verifiedText
        ? verifiedText(answer.models)
        : answer.models.length > 0
          ? t('Ui_ApiVerified', answer.models.length)
          : t('Ui_ApiVerifiedEmpty', name),
    });
  };

  const description = keySet
    ? t('Ui_ApiKeyStatusSaved')
    : optional
      ? t('Ui_ApiKeyOptional')
      : t('Ui_ApiKeyStatusNotSet');

  return (
    <StackedRow title={t('Ui_ApiKeyLabel')} description={description}>
      {({ titleId, descriptionId }) => (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Input
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                placeholder={keySet ? SAVED_KEY_MASK : t('Ui_ApiKeyPlaceholder')}
                value={keyDraft}
                onChange={(event) => {
                  setKeyDraft(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey();
                }}
                className="w-full pe-9"
              />
              <IconButton
                label={revealed ? t('Ui_ApiKeyHide') : t('Ui_ApiKeyShow')}
                icon={revealed ? EyeOff : Eye}
                size="sm"
                variant="quiet"
                aria-pressed={revealed}
                disabled={keyDraft === ''}
                onClick={() => {
                  setRevealed((current) => !current);
                }}
                className="absolute end-0.5 top-1/2 -translate-y-1/2"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={keyDraft.trim() === '' || busy !== null}
              onClick={() => {
                void saveKey();
              }}
            >
              {t('Ui_ApiKeySave')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                void verify();
              }}
            >
              {busy === 'verify' ? t('Ui_ApiVerifying') : t('Ui_ApiVerify')}
            </Button>
            {keySet ? (
              <Button
                variant="quiet"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  void removeKey();
                }}
              >
                {t('Ui_ApiKeyRemove')}
              </Button>
            ) : null}
          </div>
          <StatusLine status={status} testId="TxtApiKeyStatus" />
          {footnote ? <p className="max-w-prose text-ui text-ink-muted">{footnote}</p> : null}
        </div>
      )}
    </StackedRow>
  );
}
