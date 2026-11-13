import type { ApiEngineOptionsDto, ApiProviderKindDto } from '@vozella/contracts';
import { CircleAlert, CircleCheck, Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Autocomplete, Button, Icon, IconButton, Input } from '../../ui';
import { API_NAME_KEYS } from '../ai-provider/api-engines';
import type { ApiKeyAnswer, SettingsPageModel } from './use-settings-page';

/** Shown in the empty key field once a key is saved. A mask, never the key or any part of it. */
const SAVED_KEY_MASK = '•'.repeat(16);

/** The status line under the key: one sentence, announced politely, ink only (no status colors). */
type Status = { readonly tone: 'done' | 'problem'; readonly text: string } | null;

/** One setting stacked: words above, controls below, so a row of controls has the full width. */
function StackedRow({
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

function StatusLine({ status, testId }: { readonly status: Status; readonly testId: string }) {
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
 * The setup of an API key engine (BYOK), inside its row of the engine list (which names it): where
 * the text goes, the server address for the compatible kind, the key, Verify, and the model. The key goes to main once on Save and is never read back; the field then
 * shows a mask. Verify lists the models the key can use and adds them to the model suggestions.
 */
export function ApiProviderOptions({
  kind,
  options,
  model,
}: {
  readonly kind: ApiProviderKindDto;
  readonly options: ApiEngineOptionsDto;
  readonly model: SettingsPageModel;
}): ReactNode {
  const t = useT();
  const name = t(API_NAME_KEYS[kind]);
  const compatible = kind === 'OpenAiCompatible';

  const [keyDraft, setKeyDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | 'verify' | null>(null);
  const [keyStatus, setKeyStatus] = useState<Status>(null);
  const [verified, setVerified] = useState<readonly string[]>([]);

  const [modelDraft, setModelDraft] = useState(options.model);
  const [modelError, setModelError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState(options.baseUrl ?? '');
  const [urlError, setUrlError] = useState<string | null>(null);

  // What is saved wins whenever the page is read again.
  useEffect(() => {
    setModelDraft(options.model);
  }, [options.model]);
  useEffect(() => {
    setUrlDraft(options.baseUrl ?? '');
  }, [options.baseUrl]);

  const problem = (answer: Extract<ApiKeyAnswer, { status: 'failed' }>): Status => ({
    tone: 'problem',
    text: t(answer.errorKey as StringKey, name),
  });

  const saveKey = async (): Promise<void> => {
    if (keyDraft.trim() === '' || busy) return;
    setBusy('save');
    const answer = await model.setApiKey(kind, keyDraft);
    setBusy(null);
    if (answer.status === 'failed') {
      setKeyStatus(problem(answer));
      return;
    }
    setKeyDraft('');
    setRevealed(false);
    setKeyStatus({ tone: 'done', text: t('Ui_ApiKeySavedAnnounce') });
  };

  const removeKey = async (): Promise<void> => {
    if (busy) return;
    setBusy('remove');
    const answer = await model.clearApiKey(kind);
    setBusy(null);
    setVerified([]);
    setKeyStatus(
      answer.status === 'failed'
        ? problem(answer)
        : { tone: 'done', text: t('Ui_ApiKeyRemovedAnnounce') },
    );
  };

  const verify = async (): Promise<void> => {
    if (busy) return;
    setBusy('verify');
    setKeyStatus(null);
    const answer = await model.verifyApiKey(kind);
    setBusy(null);
    if (answer.status === 'failed') {
      setKeyStatus(problem(answer));
      return;
    }
    if (answer.status !== 'verified') return;
    setVerified(answer.models);
    setKeyStatus({
      tone: 'done',
      text:
        answer.models.length > 0
          ? t('Ui_ApiVerified', answer.models.length)
          : t('Ui_ApiVerifiedEmpty', name),
    });
  };

  /** Takes the text to save: a picked option arrives before the draft state has caught up. */
  const saveModel = async (text: string): Promise<void> => {
    const value = text.trim();
    if (value === '' || value === options.model) {
      setModelDraft(options.model);
      setModelError(null);
      return;
    }
    if (/\s/.test(value)) {
      setModelError(t('Ui_ApiModelInvalid'));
      return;
    }
    setModelError(null);
    await model.setApiOption(kind, 'model', value);
  };

  const saveUrl = async (): Promise<void> => {
    const value = urlDraft.trim();
    if (value === (options.baseUrl ?? '')) {
      setUrlError(null);
      return;
    }
    const outcome = await model.setApiOption(kind, 'baseUrl', value);
    setUrlError(
      outcome?.status === 'ignored' && outcome.reason !== 'unchanged'
        ? t('Ui_ApiBaseUrlInvalid')
        : null,
    );
  };

  const suggestions = [...new Set([...verified, ...options.modelOptions])];
  const modelChoices = suggestions.map((id) => ({
    value: id,
    label: Object.hasOwn(options.modelLabels, id) ? (options.modelLabels[id] ?? id) : id,
  }));
  const keyDescription = options.keySet
    ? t('Ui_ApiKeyStatusSaved')
    : compatible
      ? t('Ui_ApiKeyOptional')
      : t('Ui_ApiKeyStatusNotSet');

  return (
    <div className="flex flex-col" data-testid="ApiProviderOptions">
      <p className="max-w-prose pt-1 text-ui text-ink-muted">
        {compatible ? t('Ui_ApiPrivacyNoticeCompatible') : t('Ui_ApiPrivacyNotice', name)}
      </p>
      <div>
        {compatible ? (
          <StackedRow title={t('Ui_ApiBaseUrlLabel')} description={t('Ui_ApiBaseUrlHelp')}>
            {({ titleId, descriptionId }) => (
              <div className="flex flex-col gap-1.5">
                <Input
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  autoComplete="off"
                  aria-labelledby={titleId}
                  aria-describedby={urlError ? `${descriptionId} ${titleId}-error` : descriptionId}
                  aria-invalid={urlError ? true : undefined}
                  placeholder="https://openrouter.ai/api/v1"
                  value={urlDraft}
                  onChange={(event) => {
                    setUrlDraft(event.currentTarget.value);
                  }}
                  onBlur={() => {
                    void saveUrl();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveUrl();
                  }}
                  className="w-full max-w-md"
                />
                {urlError ? (
                  <p id={`${titleId}-error`} className="flex gap-1.5 text-ui text-ink">
                    <Icon icon={CircleAlert} size={14} className="mt-[3px] shrink-0" />
                    <span>{urlError}</span>
                  </p>
                ) : null}
              </div>
            )}
          </StackedRow>
        ) : null}

        <StackedRow title={t('Ui_ApiKeyLabel')} description={keyDescription}>
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
                    placeholder={options.keySet ? SAVED_KEY_MASK : t('Ui_ApiKeyPlaceholder')}
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
                {options.keySet ? (
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
              <StatusLine status={keyStatus} testId="TxtApiKeyStatus" />
            </div>
          )}
        </StackedRow>

        <StackedRow title={t('Ui_ApiModelLabel')} description={t('Ui_ApiModelHelp')}>
          {({ titleId, descriptionId }) => (
            <div className="flex flex-col gap-1.5">
              <Autocomplete
                options={modelChoices}
                value={modelDraft}
                onValueChange={setModelDraft}
                onCommit={(value) => {
                  void saveModel(value);
                }}
                aria-labelledby={titleId}
                aria-describedby={modelError ? `${descriptionId} ${titleId}-error` : descriptionId}
                aria-invalid={modelError ? true : undefined}
                openLabel={t('Ui_ApiModelShowSuggestions')}
                listTestId="ListApiModels"
                className="w-full max-w-xs"
              />
              {modelError ? (
                <p id={`${titleId}-error`} className="flex gap-1.5 text-ui text-ink">
                  <Icon icon={CircleAlert} size={14} className="mt-[3px] shrink-0" />
                  <span>{modelError}</span>
                </p>
              ) : null}
            </div>
          )}
        </StackedRow>
      </div>
    </div>
  );
}
