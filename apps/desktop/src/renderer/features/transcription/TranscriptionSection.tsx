import type {
  EngineStatusDto,
  SettingsPageDto,
  TranscriptionEngineKindDto,
} from '@vozella/contracts';
import {
  CLOUD_TRANSCRIPTION_ENGINE_LIST,
  CLOUD_TRANSCRIPTION_ENGINES,
  INSTALL_STAGE_LABEL_KEYS,
  isCloudTranscriptionKind,
  LIVE_DROP_WARNING_PERCENT,
  LOCAL_TRANSCRIPTION_ENGINE,
  type CloudLiveText,
  type CloudTranscriptionKind,
} from '@vozella/core';
import { CircleDashed, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { StringKey, Translate } from '../../i18n/translate';
import {
  Badge,
  Button,
  ConfirmDialog,
  Icon,
  Notice,
  Progress,
  RadioGroup,
  SectionHeader,
  SettingRow,
  Switch,
  type RadioOption,
} from '../../ui';
import type { ApiKeyActions } from '../ai-provider/ApiKeyField';
import { KEY_PROVIDER_NAME_KEYS } from '../ai-provider/api-engines';
import { ProviderMark } from '../ai-provider/ProviderMark';
import { CloudEngineSetup } from './CloudEngineSetup';
import { overallPercent } from './live-lines';
import {
  onTranscriptionFocus,
  takeTranscriptionFocus,
  type TranscriptionFocus,
} from './transcription-focus';
import { useEngineActions } from './use-engine-actions';
import { useEngineInstall } from './use-engine-install';
import { useEngineStatus } from './use-engine-status';
import { useSpeakerModel } from './use-speaker-model';

/**
 * The words that depend on how the live text of a cloud engine arrives: the line under its name
 * in the engine choice, and the description of the live switch. `{0}` is the provider's name.
 */
const LIVE_TEXT_KEYS: Readonly<
  Record<CloudLiveText, { readonly choice: StringKey; readonly live: StringKey }>
> = {
  pieces: { choice: 'Ui_TranscriptionCloudHelp', live: 'Ui_LiveCloudDescription' },
  streaming: { choice: 'Ui_TranscriptionStreamingHelp', live: 'Ui_LiveStreamingDescription' },
};

export interface TranscriptionSectionProps {
  /** The Settings page snapshot: which cloud engines have their key, and the saved cloud model. */
  readonly page: Pick<SettingsPageDto, 'transcriptionKeys' | 'settings'>;
  /** The key commands of the Settings page, and its reload after a setting changed. */
  readonly model: ApiKeyActions & { readonly load: () => Promise<void> };
}

/** A cloud model is kept across a change of engine only when the new engine lists it. */
function keepsModel(kind: CloudTranscriptionKind, saved: string | null | undefined): boolean {
  const id = saved?.trim() ?? '';
  if (id === '') return true;
  return CLOUD_TRANSCRIPTION_ENGINE_LIST.some(
    (engine) => engine.kind === kind && engine.models.includes(id),
  );
}

/**
 * Settings, Transcription (spec 2.6, 2.6.1): where meetings are transcribed (this PC or a cloud
 * engine with the user's API key), the setup of the cloud engine in use, the engine on this PC
 * (download, delete, which processor it runs on), the live preview, and speaker labels with their
 * model in one row. Labels are plain words; model names stay in descriptions and in the buttons'
 * accessible names. The language is chosen in the meeting language block above. What is shown
 * comes from the status the main process keeps, which main publishes again whenever the engine
 * setting or a key changes.
 */
export function TranscriptionSection({ page, model }: TranscriptionSectionProps) {
  const { t, locale } = useI18n();
  const { status, refresh } = useEngineStatus();
  const install = useEngineInstall();
  // Deletes ask first; the outcome is spoken through one polite live region.
  const [confirming, setConfirming] = useState<'engine' | 'speaker' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const engine = useEngineActions({ start: install.start, refresh, announce: setAnnouncement });
  const speaker = useSpeakerModel({ refresh, announce: setAnnouncement });
  // The radio moves at once; the status main answers with is what stays.
  const [chosen, setChosen] = useState<TranscriptionEngineKindDto | null>(null);
  // The cloud setup fades in when a choice opens it, not when the page draws it on a visit.
  const [choseHere, setChoseHere] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const selected: TranscriptionEngineKindDto =
    chosen ?? status?.engine ?? LOCAL_TRANSCRIPTION_ENGINE;
  const cloud = isCloudTranscriptionKind(selected) ? selected : null;
  const cloudName = cloud ? t(KEY_PROVIDER_NAME_KEYS[cloud]) : '';
  const cloudKeySet = cloud !== null && page.transcriptionKeys[cloud];
  // TEMPORARY (deepgram-streaming-transcription T1): an engine this version cannot run yet. The
  // status of main is about the saved engine, so it only counts once the choice has settled.
  const cloudUnavailable =
    cloud !== null && status?.engine === cloud && status.cloudNotReadyReason === 'unavailable';

  // The recognizer snapshot only counts while it still matches the current settings.
  const speakerModelMissing =
    cloud === null &&
    status !== null &&
    status.usage?.diarization === 'model-missing' &&
    status.speakerLabelsEnabled &&
    !status.speakerModelInstalled;

  const ask = (what: 'engine' | 'speaker'): void => {
    setAnnouncement('');
    setConfirming(what);
  };

  const installing = install.phase === 'running';
  // `ready` is about the engine in use. With a cloud engine, the one on this PC is ready when its
  // model and a runtime are on disk.
  const localReady =
    status !== null &&
    (status.engine === LOCAL_TRANSCRIPTION_ENGINE
      ? status.ready
      : status.modelInstalled && (status.runtimes.cpu || status.runtimes.cuda));
  // Live captions need the engine in use: without it the switch says why instead of showing On.
  const liveUnavailable = status !== null && !status.ready;
  const liveOn = !liveUnavailable && (status?.liveEnabled ?? false);
  const anyEngineFile =
    status !== null && (status.modelInstalled || status.runtimes.cpu || status.runtimes.cuda);

  const save = async (patch: Record<string, string | null>): Promise<void> => {
    try {
      await window.vozella.invoke('settings.update', { patch });
    } catch {
      // The status read below puts the control back to what is saved.
    }
    await Promise.all([refresh(), model.load()]);
  };

  const choose = (next: string): void => {
    if (next === selected) return;
    const kind = isCloudTranscriptionKind(next) ? next : LOCAL_TRANSCRIPTION_ENGINE;
    setChosen(kind);
    setChoseHere(true);
    const patch: Record<string, string | null> =
      kind === LOCAL_TRANSCRIPTION_ENGINE
        ? // A null engine is this PC; the cloud model stays for the next time.
          { transcriptionEngine: null }
        : keepsModel(kind, page.settings.cloudTranscriptionModelId)
          ? { transcriptionEngine: kind }
          : { transcriptionEngine: kind, cloudTranscriptionModelId: null };
    void save(patch).finally(() => {
      setChosen(null);
    });
  };

  // A link from the Record page lands here: on the key field, or on the engine in use.
  const [focusTarget, setFocusTarget] = useState<TranscriptionFocus | null>(null);
  useEffect(() => {
    const linked = takeTranscriptionFocus();
    if (linked) setFocusTarget(linked);
    return onTranscriptionFocus((target) => {
      takeTranscriptionFocus();
      setFocusTarget(target);
    });
  }, []);
  const statusKnown = status !== null;
  useEffect(() => {
    if (focusTarget === null || !statusKnown) return;
    const section = root.current;
    const key =
      focusTarget === 'key' ? section?.querySelector<HTMLElement>('[data-cloud-key] input') : null;
    const target =
      key ?? section?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? null;
    if (target === null) return;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
    setFocusTarget(null);
  }, [focusTarget, statusKnown, cloud]);

  const options: RadioOption[] = [
    {
      value: LOCAL_TRANSCRIPTION_ENGINE,
      disabled: status === null,
      label: (
        <span className="flex items-center gap-2">
          <ProviderMark kind="Local" />
          {t('Ui_TranscriptionLocalName')}
        </span>
      ),
      description: t('Ui_TranscriptionLocalHelp'),
    },
    ...CLOUD_TRANSCRIPTION_ENGINE_LIST.map(({ kind, liveText }): RadioOption => {
      const name = t(KEY_PROVIDER_NAME_KEYS[kind]);
      const keySet = page.transcriptionKeys[kind];
      const keyText = t(keySet ? 'Ui_SummaryEngineKeySaved' : 'Ui_SummaryEngineNeedsKey');
      return {
        value: kind,
        disabled: status === null,
        label: (
          <span className="flex items-center gap-2">
            <ProviderMark kind={kind} />
            {name}
            {/* Read with the name; the same words are drawn beside the row. */}
            <span className="sr-only">, {keyText}</span>
          </span>
        ),
        description: t(LIVE_TEXT_KEYS[liveText].choice, name),
        trailing: (
          <span
            aria-hidden="true"
            data-testid={`engine-key-${kind}`}
            className="flex items-center gap-1.5 text-ui text-ink-muted"
          >
            <Icon icon={keySet ? KeyRound : CircleDashed} size={14} />
            {keyText}
          </span>
        ),
      };
    }),
  ];

  return (
    <div data-testid="transcription-section" ref={root}>
      <SectionHeader level={2} compact title={t('Settings_Transcription.Text')} className="pb-2" />
      {/* Kept above the rows: a trailing sibling would stop the last row dropping its hairline. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <div className="border-b border-hairline pb-1">
        <p className="max-w-prose pb-1 text-ui text-ink-muted">
          {t('Ui_TranscriptionEngineChoiceHelp')}
        </p>
        <RadioGroup
          label={t('Ui_TranscriptionEngineChoiceLabel')}
          layout="rows"
          value={selected}
          onValueChange={choose}
          options={options}
        />
      </div>

      {cloud ? (
        <CloudEngineSetup
          // One panel per engine: a switch between two cloud engines draws the new one afresh.
          key={cloud}
          reveal={choseHere}
          kind={cloud}
          keySet={cloudKeySet}
          unavailable={cloudUnavailable}
          keys={model}
          savedModel={page.settings.cloudTranscriptionModelId ?? null}
          onModelChange={(next) => {
            void save({ cloudTranscriptionModelId: next });
          }}
        />
      ) : null}

      <SettingRow
        title={cloud ? t('Ui_EngineLocalTitle') : t('Ui_EngineTitle')}
        description={
          <>
            <span className="block">
              {cloud ? t('Ui_EngineLocalUnused', cloudName) : t('Ui_EngineDescription')}
            </span>
            {/* The processor line is about a pass on this PC; a failed download always shows. */}
            {status && (cloud === null || engine.note) ? (
              <span className="block pt-1" data-testid="acceleration-caption">
                {engine.note ?? backendCaption(status, t)}
              </span>
            ) : null}
          </>
        }
      >
        {status ? (
          <Badge tone="outline">
            {localReady ? t('Ui_EngineInstalled') : t('Ui_EngineNotInstalled')}
          </Badge>
        ) : null}
        <Button
          disabled={status === null || localReady || installing}
          aria-label={`${t('Settings_DownloadEngine.Content')} ${t('Settings_NemotronCard.Header')}`}
          onClick={() => {
            // With a cloud engine in use the selected engine downloads nothing: ask for this one.
            void engine.download(cloud ? { local: true } : undefined);
          }}
        >
          {t('Settings_DownloadEngine.Content')}
        </Button>
        {/* Delete is offered only for files that are on this PC, as in the model list. */}
        {anyEngineFile ? (
          <Button
            variant="quiet"
            disabled={installing || speaker.busy !== null}
            aria-label={`${t('Settings_DeleteEngine.Content')} ${t('Settings_NemotronCard.Header')}`}
            onClick={() => {
              ask('engine');
            }}
          >
            {t('Settings_DeleteEngine.Content')}
          </Button>
        ) : null}
      </SettingRow>

      {installing ? (
        <div className="border-b border-hairline py-3.5" data-testid="engine-progress">
          <Progress
            className="max-w-sm"
            label={
              install.progress
                ? t(INSTALL_STAGE_LABEL_KEYS[install.progress.stage] as StringKey)
                : t('Status_StartingDownload')
            }
            value={install.progress ? overallPercent(install.progress) : null}
            showValue={install.progress !== null}
          />
        </div>
      ) : null}

      {status ? <EngineNotices status={status} locale={locale} /> : null}

      <SettingRow
        title={t('Settings_LiveTranscription.Header')}
        description={
          liveUnavailable
            ? cloud
              ? t(cloudUnavailable ? 'Ui_CloudEngineUnavailable' : 'Ui_LiveNeedsKey', cloudName)
              : t('Ui_LiveNeedsEngine')
            : cloud
              ? t(LIVE_TEXT_KEYS[CLOUD_TRANSCRIPTION_ENGINES[cloud].liveText].live, cloudName)
              : t('Ui_LiveTranscriptionDescription')
        }
      >
        {({ titleId }) => (
          <Switch
            aria-labelledby={titleId}
            label={liveOn ? t('Ui_SwitchOn') : t('Ui_SwitchOff')}
            checked={liveOn}
            disabled={status === null || liveUnavailable}
            onCheckedChange={engine.setLive}
          />
        )}
      </SettingRow>

      {/* One row: the switch and the model it needs (download and delete). */}
      <SettingRow
        title={t('Settings_SpeakerLabels.Header')}
        description={
          cloud
            ? t('Ui_SpeakerLabelsCloudUnavailable', cloudName)
            : t('Ui_SpeakerLabelsDescription')
        }
      >
        {({ titleId, descriptionId }) => (
          <>
            {/* A cloud engine hears no speakers, so the model it would need is not offered. */}
            {cloud ? null : (
              <Button
                disabled={status === null || status.speakerModelInstalled || speaker.busy !== null}
                aria-label={`${t('Settings_DownloadSpeakers.Content')} ${t('Ui_SpeakerModel')}`}
                onClick={speaker.download}
              >
                {t('Settings_DownloadSpeakers.Content')}
              </Button>
            )}
            {cloud === null && status?.speakerModelInstalled ? (
              <Button
                variant="quiet"
                disabled={speaker.busy !== null}
                aria-label={`${t('Settings_DeleteSpeakers.Content')} ${t('Ui_SpeakerModel')}`}
                onClick={() => {
                  ask('speaker');
                }}
              >
                {t('Settings_DeleteSpeakers.Content')}
              </Button>
            ) : null}
            {/* With a cloud engine the saved choice stays on screen, disabled, with the reason. */}
            <Switch
              aria-labelledby={titleId}
              aria-describedby={cloud ? descriptionId : undefined}
              className="pl-2"
              label={status?.speakerLabelsEnabled ? t('Ui_SwitchOn') : t('Ui_SwitchOff')}
              checked={status?.speakerLabelsEnabled ?? false}
              disabled={status === null || speaker.busy !== null || cloud !== null}
              onCheckedChange={speaker.setLabels}
            />
          </>
        )}
      </SettingRow>
      {speaker.busy !== null || speaker.note || speakerModelMissing ? (
        <div className="flex flex-col gap-2.5 border-b border-hairline py-3">
          {speaker.busy === 'download' ? (
            <Progress
              className="max-w-sm"
              label={t('Ui_SpeakerDownloading')}
              value={speaker.percent}
              showValue
            />
          ) : null}
          {speaker.note ? (
            <p className="text-ui-lg text-ink" role="status">
              {speaker.note}
            </p>
          ) : null}
          {speakerModelMissing ? (
            <Notice tone="warning">{t('Ui_SpeakerModelMissing')}</Notice>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t(confirming === 'speaker' ? 'Ui_SpeakerDeleteTitle' : 'Ui_EngineDeleteTitle')}
        description={t(
          confirming === 'speaker' ? 'Ui_SpeakerDeleteContent' : 'Ui_EngineDeleteContent',
        )}
        cancelLabel={t('HistoryDelete_Cancel')}
        closeLabel={t('Ui_Close')}
        primaryLabel={t(
          confirming === 'speaker'
            ? 'Settings_DeleteSpeakers.Content'
            : 'Settings_DeleteEngine.Content',
        )}
        onConfirm={() => {
          if (confirming === 'speaker') speaker.remove();
          else if (confirming === 'engine') void engine.remove();
        }}
      />
    </div>
  );
}

/** Which processor runs the engine, or will. Shown under the engine description. */
function backendCaption(status: EngineStatusDto, t: Translate): string {
  const usage = status.usage;
  if (usage) {
    return usage.backend === 'cuda'
      ? t('Ui_AccelerationActiveGpu')
      : t('Settings_AccelerationActiveCpu');
  }
  return status.expectedBackend === 'cuda'
    ? t('Ui_AccelerationExpectedGpu')
    : t('Settings_AccelerationExpectedCpu');
}

/** The GPU fallback reason and the last live session's drops, when there is something to say. */
function EngineNotices({ status, locale }: { status: EngineStatusDto; locale: string }) {
  const { t } = useI18n();
  const usage = status.usage;
  const dropped = status.liveDroppedPercent;
  if (!usage?.fallbackReason && dropped === null) return null;
  const droppedText =
    dropped === null
      ? ''
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(dropped);
  const warnDrops = dropped !== null && dropped > LIVE_DROP_WARNING_PERCENT;

  return (
    <div className="flex flex-col gap-2.5 border-b border-hairline py-3">
      {usage?.fallbackReason ? (
        <Notice tone="warning">
          <span className="block font-medium">{t('Settings_AsrFallback.Title')}</span>
          <span className="block text-ink-muted">
            {t('Settings_AccelerationFallbackMessage', usage.fallbackReason)}
          </span>
        </Notice>
      ) : null}
      {warnDrops ? (
        <Notice tone="warning">
          <span className="block font-medium">{t('Settings_LiveDropsWarning.Title')}</span>
          <span className="block text-ink-muted">
            {t('Settings_LiveDropsWarningMessage', droppedText)}
          </span>
        </Notice>
      ) : dropped !== null ? (
        <p className="text-ui-lg text-ink-muted" data-testid="live-drops-caption">
          {t('Settings_LiveDropsCaption', droppedText)}
        </p>
      ) : null}
    </div>
  );
}
