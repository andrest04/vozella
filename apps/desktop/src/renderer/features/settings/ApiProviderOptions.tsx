import type { ApiEngineOptionsDto, ApiProviderKindDto } from '@vozella/contracts';
import { CircleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Autocomplete, Icon, Input } from '../../ui';
import { ApiKeyField, StackedRow } from '../ai-provider/ApiKeyField';
import { API_NAME_KEYS } from '../ai-provider/api-engines';
import type { SettingsPageModel } from './use-settings-page';

/**
 * The setup of an API key engine (BYOK), inside its row of the engine list (which names it): where
 * the text goes, the server address for the compatible kind, the key row (`ApiKeyField`), and the
 * model. Verify lists the models the key can use and adds them to the model suggestions.
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

        <ApiKeyField
          kind={kind}
          keySet={options.keySet}
          optional={compatible}
          actions={model}
          onVerified={setVerified}
        />

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
