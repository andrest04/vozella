import type { SettingsPageDto, SummaryEngineReadinessDto } from '@vozella/contracts';
import { CLI_STATUS_KEYS } from '@vozella/core';
import { Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button, Icon, Notice, SectionHeader, Select, SettingRow } from '../../ui';
import { SetupWizardDialog } from '../ai-provider/SetupWizardDialog';
import { API_NAME_KEYS, isApiKind } from '../ai-provider/api-engines';
import { ApiProviderOptions } from './ApiProviderOptions';
import { EngineList, type EngineGroupView } from './EngineList';
import { LocalModels } from './LocalModels';
import {
  ENGINE_GROUPS,
  ENGINE_STATUS_KEYS,
  engineStatus,
  isEngineKind,
  type EngineKind,
} from './engine-status';
import type { CliEngineKind, SettingsPageModel } from './use-settings-page';

interface CliKeys {
  readonly name: 'Settings_ClaudeOptions.Header' | 'Settings_CodexOptions.Header';
  readonly description: 'Settings_ClaudeOptions.Description' | 'Settings_CodexOptions.Description';
  readonly model: 'Settings_ClaudeModel.Header' | 'Settings_CodexModel.Header';
  readonly effort: 'Settings_ClaudeEffort.Header' | 'Settings_CodexEffort.Header';
  /** The page block and the setting that hold this CLI's options. */
  readonly id: 'claude' | 'codex';
}

const CLI_KEYS: Readonly<Record<CliEngineKind, CliKeys>> = {
  ClaudeCode: {
    name: 'Settings_ClaudeOptions.Header',
    description: 'Settings_ClaudeOptions.Description',
    model: 'Settings_ClaudeModel.Header',
    effort: 'Settings_ClaudeEffort.Header',
    id: 'claude',
  },
  Codex: {
    name: 'Settings_CodexOptions.Header',
    description: 'Settings_CodexOptions.Description',
    model: 'Settings_CodexModel.Header',
    effort: 'Settings_CodexEffort.Header',
    id: 'codex',
  },
};

const isCliKind = (kind: EngineKind): kind is CliEngineKind =>
  kind === 'ClaudeCode' || kind === 'Codex';

/** A CLI engine's setup: whether its program is on the PATH, Check again, its model and effort. */
function CliSetup({
  kind,
  readiness,
  page,
  model,
}: {
  readonly kind: CliEngineKind;
  readonly readiness: SummaryEngineReadinessDto | null;
  readonly page: SettingsPageDto;
  readonly model: SettingsPageModel;
}): ReactNode {
  const t = useT();
  const keys = CLI_KEYS[kind];
  const options = page[keys.id];
  const items = (list: readonly string[]) => list.map((value) => ({ value, label: value }));
  const detection =
    readiness === 'ready'
      ? t(CLI_STATUS_KEYS.found)
      : readiness === 'cli-missing'
        ? t(CLI_STATUS_KEYS.missing)
        : '';
  return (
    <div className="flex flex-col">
      <p className="max-w-prose pt-2 text-ui text-ink-muted">{t(keys.description)}</p>
      <div className="flex flex-wrap items-center gap-3 pt-1 text-ui-lg text-ink-muted">
        <span role="status" className="empty:hidden">
          {detection}
        </span>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            void model.checkCliAgain(kind);
          }}
        >
          {t('Ui_CliCheckAgain')}
        </Button>
      </div>
      <SettingRow title={t(keys.model)}>
        <Select
          label={t(keys.model)}
          value={options.model}
          options={items(options.modelOptions)}
          onValueChange={(value) => {
            if (value !== options.model) model.setCliOption(keys.id, 'model', value);
          }}
        />
      </SettingRow>
      <SettingRow title={t(keys.effort)}>
        <Select
          label={t(keys.effort)}
          value={options.effort}
          options={items(options.effortOptions)}
          onValueChange={(value) => {
            if (value !== options.effort) model.setCliOption(keys.id, 'effort', value);
          }}
        />
      </SettingRow>
    </div>
  );
}

/** The local models: Set up while none is active, then the model list. */
function LocalSetup({
  page,
  model,
  onSetUp,
}: {
  readonly page: SettingsPageDto;
  readonly model: SettingsPageModel;
  readonly onSetUp: () => void;
}): ReactNode {
  const t = useT();
  if (!page.capabilities.localModels) return null;
  const noActiveModel = !page.models.rows.some((row) => row.active);
  return (
    <div className="flex flex-col pt-3">
      <SectionHeader
        level={3}
        title={t('Settings_SummaryModels.Header')}
        description={t('Settings_SummaryModels.Description')}
        action={
          noActiveModel ? (
            <Button variant="primary" size="sm" onClick={onSetUp}>
              {t('RecordingSetup_SetUp')}
            </Button>
          ) : undefined
        }
      />
      <div className="pt-1">
        <LocalModels
          rows={page.models.rows}
          missingActiveId={page.models.missingActiveId}
          progress={model.progress}
          onSelect={model.selectModel}
          onDownload={(fileName) => {
            void model.downloadModel(fileName);
          }}
          onCancel={model.cancelModel}
          onDelete={model.deleteModel}
        />
      </div>
    </div>
  );
}

/**
 * The first line of an engine's setup: In use, the button that makes it the engine in use once it
 * is ready, or what it still needs. An engine in use that lost what it needs says both.
 */
function EngineUse({
  inUse,
  ready,
  missing,
  onUse,
}: {
  readonly inUse: boolean;
  readonly ready: boolean;
  readonly missing: string | null;
  readonly onUse: () => void;
}): ReactNode {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-1 pt-1">
      {inUse ? (
        <p className="flex items-center gap-1.5 text-ui text-ink">
          <Icon icon={Check} size={14} />
          {t('Ui_SummaryEngineInUseLine')}
        </p>
      ) : null}
      {!inUse && ready ? (
        <Button variant="primary" size="sm" onClick={onUse}>
          {t('Ui_SummaryEngineUse')}
        </Button>
      ) : null}
      {missing && !ready ? <p className="text-ui text-ink-muted">{missing}</p> : null}
    </div>
  );
}

/**
 * Where summaries are made: every engine with its status, and the setup of the open one beneath
 * its row (local models, a CLI's model and effort, or an API engine's key, model and address).
 * Opening a row never changes the engine in use; "Use this engine" does, and only once the engine
 * is ready. The engine in use opens first. A settings file that still names the removed Grok
 * provider shows a notice and no engine in use, so the user picks another one.
 */
export function ProviderSection({
  page,
  model,
}: {
  page: SettingsPageDto;
  model: SettingsPageModel;
}) {
  const t = useT();
  const { provider } = page;
  const [wizardOpen, setWizardOpen] = useState(false);
  const [openKind, setOpenKind] = useState<EngineKind | null>(
    isEngineKind(provider) ? provider : null,
  );

  const readinessOf = (kind: EngineKind): SummaryEngineReadinessDto | null =>
    page.engines.find((engine) => engine.kind === kind)?.readiness ?? null;

  const nameOf = (kind: EngineKind): string => {
    if (isApiKind(kind)) return t(API_NAME_KEYS[kind]);
    if (isCliKind(kind)) return t(CLI_KEYS[kind].name);
    return t('Settings_ProviderLocal.Text');
  };

  const missingOf = (kind: EngineKind): string | null => {
    switch (readinessOf(kind)) {
      case 'cli-missing':
        return t('Ui_SummaryEngineMissingCli', nameOf(kind));
      case 'needs-key':
        return t('Ui_SummaryEngineMissingKey', nameOf(kind));
      case 'needs-server':
        return t('Ui_SummaryEngineMissingServer');
      case 'needs-model':
        return kind === 'Local'
          ? t('Ui_SummaryEngineMissingLocalModel')
          : t('Ui_SummaryEngineMissingApiModel', nameOf(kind));
      default:
        return null;
    }
  };

  const groups: EngineGroupView[] = ENGINE_GROUPS.map((group) => ({
    caption: t(group.caption),
    rows: group.engines.map((engine) => {
      const inUse = provider === engine.kind;
      const status = engineStatus(engine.kind, readinessOf(engine.kind), {
        inUse,
        keySet: isApiKind(engine.kind) && page.api[engine.kind].keySet,
      });
      return {
        kind: engine.kind,
        name: t(engine.name),
        status,
        statusText: status ? t(ENGINE_STATUS_KEYS[status]) : '',
        model: inUse
          ? (page.engines.find((entry) => entry.kind === engine.kind)?.model ?? null)
          : null,
      };
    }),
  }));

  const renderPanel = (kind: EngineKind): ReactNode => (
    <div className="flex flex-col">
      <EngineUse
        inUse={provider === kind}
        ready={readinessOf(kind) === 'ready'}
        missing={missingOf(kind)}
        onUse={() => {
          void model.setProvider(kind);
        }}
      />
      {kind === 'Local' ? (
        <LocalSetup
          page={page}
          model={model}
          onSetUp={() => {
            setWizardOpen(true);
          }}
        />
      ) : null}
      {isCliKind(kind) ? (
        <CliSetup kind={kind} readiness={readinessOf(kind)} page={page} model={model} />
      ) : null}
      {isApiKind(kind) ? (
        <ApiProviderOptions key={kind} kind={kind} options={page.api[kind]} model={model} />
      ) : null}
    </div>
  );

  return (
    <div>
      <SectionHeader
        level={2}
        compact
        title={t('Settings_SummaryProvider.Text')}
        className="pb-2"
      />
      <p className="max-w-prose pb-4 text-ui text-ink-muted">
        {t('Ui_SummaryProviderCardDescription')}
      </p>

      {page.providerNotice === 'xai-removed' ? (
        <Notice tone="warning" className="mb-4">
          {t('Ui_SummaryProviderXaiRemoved')}
        </Notice>
      ) : null}

      <EngineList
        label={t('Settings_SummaryProviderCard.Header')}
        groups={groups}
        openKind={openKind}
        onToggle={(kind) => {
          setOpenKind((current) => (current === kind ? null : kind));
        }}
        renderPanel={renderPanel}
      />

      <SetupWizardDialog
        open={wizardOpen}
        mode="local-only"
        onFinished={() => {
          setWizardOpen(false);
          void model.load();
        }}
      />

      {model.feedback ? (
        <Notice className="mt-4" onDismiss={model.clearFeedback} dismissLabel={t('Ui_Close')}>
          {model.feedback}
        </Notice>
      ) : null}
    </div>
  );
}
