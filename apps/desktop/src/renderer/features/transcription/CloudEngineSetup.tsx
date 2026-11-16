import {
  CLOUD_TRANSCRIPTION_ENGINE_LIST,
  resolveCloudTranscriptionModel,
  type CloudTranscriptionKind,
} from '@vozella/core';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button, Icon, Notice, Select, SettingRow, cn } from '../../ui';
import { ApiKeyField, type ApiKeyActions } from '../ai-provider/ApiKeyField';
import { isApiKind, KEY_PROVIDER_NAME_KEYS } from '../ai-provider/api-engines';

/**
 * How to get a key, for someone who has never seen an API key: where to go, what to do there, and
 * who charges for it. A disclosure, open while no key is saved. The link goes to the provider's
 * own key page and opens in the system browser (main denies the window and hands over https
 * addresses only, see security/external-url).
 */
function KeyGuide({
  name,
  url,
  keySet,
}: {
  readonly name: string;
  readonly url: string;
  readonly keySet: boolean;
}): ReactNode {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(!keySet);
  // The steps fade in only as the answer to a press, never when the page first draws them.
  const [pressed, setPressed] = useState(false);
  // Saving the key folds the guide; removing it opens the guide again.
  useEffect(() => {
    setOpen(!keySet);
  }, [keySet]);

  return (
    <div className="flex flex-col items-start gap-2 border-b border-hairline py-2.5">
      <Button
        variant="quiet"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setPressed(true);
          setOpen((current) => !current);
        }}
        className="-ms-2.5"
      >
        {t('Ui_CloudKeyGuideTitle', name)}
        <Icon
          icon={ChevronDown}
          size={14}
          className={cn(
            'text-ink-faint transition-transform duration-150 ease-out-quick motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </Button>
      {open ? (
        <div
          id={panelId}
          className={cn('flex flex-col gap-2.5 pb-1', pressed && 'animate-fade-in')}
        >
          <ol className="flex max-w-prose list-decimal flex-col gap-1 ps-5 text-ui-lg text-ink marker:text-ink-muted">
            <li>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-control underline underline-offset-2 hover:opacity-80"
              >
                {t('Ui_CloudKeyGuideOpen', name)}
                <Icon icon={ExternalLink} size={12} className="shrink-0" />
                <span className="sr-only"> {t('Ui_OpensInBrowser')}</span>
              </a>
            </li>
            <li>{t('Ui_CloudKeyGuideSignIn')}</li>
            <li>{t('Ui_CloudKeyGuideCreate')}</li>
            <li>{t('Ui_CloudKeyGuidePaste')}</li>
          </ol>
          <p className="max-w-prose text-ui text-ink-muted">{t('Ui_CloudKeyGuideCost', name)}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The setup of the cloud transcription engine in use, under the engine choice: that the meeting
 * audio goes to this provider, its API key, how to get one, and the speech model. The key row is
 * the one of the API engines of the summaries. For a provider that is also one of them it is the
 * same key, and the row says so; a provider that only transcribes has its own key, and the row
 * says it is used for nothing else. Models come from core's table: the list a Verify returns
 * leaves the speech models out. A provider with one model shows its name, not a list of one.
 */
export function CloudEngineSetup({
  kind,
  keySet,
  keys,
  savedModel,
  onModelChange,
  reveal = false,
}: {
  /** The panel opened because the user just chose this engine: it fades in. */
  readonly reveal?: boolean;
  readonly kind: CloudTranscriptionKind;
  readonly keySet: boolean;
  readonly keys: ApiKeyActions;
  /** The saved model id; null, or one this engine does not list, is the provider's default. */
  readonly savedModel: string | null;
  readonly onModelChange: (model: string) => void;
}): ReactNode {
  const t = useT();
  const name = t(KEY_PROVIDER_NAME_KEYS[kind]);
  const engine = CLOUD_TRANSCRIPTION_ENGINE_LIST.find((entry) => entry.kind === kind);
  if (!engine) return null;

  // The model this engine is asked for: a saved id it does not list (one of another engine, for
  // instance) resolves to its default, so what is shown is what is sent.
  const current = resolveCloudTranscriptionModel(kind, savedModel);
  const models = engine.models.map((id) => ({ value: id, label: engine.modelNames[id] ?? id }));
  // One model is nothing to choose: the row names it instead of offering a list of one.
  const onlyModel = models.length === 1 ? models[0] : undefined;

  return (
    <div
      role="group"
      aria-label={t('Ui_CloudSetupGroup', name)}
      data-testid="cloud-engine-setup"
      className={cn(
        'flex flex-col border-b border-hairline ps-6.5 pt-3',
        reveal && 'animate-fade-in',
      )}
    >
      <Notice tone="info">{t('Ui_CloudAudioNotice', name)}</Notice>
      <div data-cloud-key>
        <ApiKeyField
          // A key typed for one provider is never carried over to another.
          key={kind}
          kind={kind}
          keySet={keySet}
          actions={keys}
          verifiedText={() => t('Ui_ApiVerifiedKeyWorks', name)}
          footnote={
            isApiKind(kind) ? t('Ui_CloudSameKey', name) : t('Ui_CloudKeyTranscriptionOnly')
          }
        />
      </div>
      <KeyGuide key={`${kind}-guide`} name={name} url={engine.keyPageUrl} keySet={keySet} />
      {onlyModel ? (
        <SettingRow title={t('Ui_CloudModelLabel')} description={t('Ui_CloudModelOnlyHelp', name)}>
          <span data-testid="TxtCloudModel" className="text-ui-lg text-ink">
            {onlyModel.label}
          </span>
        </SettingRow>
      ) : (
        <SettingRow title={t('Ui_CloudModelLabel')} description={t('Ui_CloudModelHelp', name)}>
          <Select
            label={t('Ui_CloudModelLabel')}
            value={current}
            options={models}
            onValueChange={(next) => {
              if (next !== current) onModelChange(next);
            }}
            testId="SelCloudModel"
          />
        </SettingRow>
      )}
    </div>
  );
}
