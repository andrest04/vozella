import type { SettingsPageDto } from '@vozella/contracts';
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, Dialog, Notice } from '../../ui';
import { LocalModels } from './LocalModels';
import type { SettingsPageModel } from './use-settings-page';

/**
 * The Local engine's setup: the active model on one line, and "Change model" for the full list in a
 * dialog, where models download, are deleted and are chosen. While no model is active, Set up
 * (the wizard) leads. Nothing is drawn when the local models module is not present.
 */
export function LocalEngineSetup({
  page,
  model,
  onSetUp,
}: {
  readonly page: SettingsPageDto;
  readonly model: SettingsPageModel;
  readonly onSetUp: () => void;
}): ReactNode {
  const t = useT();
  const [listOpen, setListOpen] = useState(false);
  if (!page.capabilities.localModels) return null;
  const { rows, missingActiveId } = page.models;
  const active = rows.find((row) => row.active) ?? null;

  const changeModel = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        setListOpen(true);
      }}
    >
      {t('Ui_SummaryEngineChangeModel')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2 pt-3">
      {active ? (
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui-lg text-ink">
              <span className="font-medium">{active.displayName}</span>{' '}
              <span className="text-ink-muted">{active.vendor}</span>
            </span>
            <span className="text-ui text-ink-muted">
              {t(
                'Model_SpeedQuality',
                t(active.speedKey as StringKey),
                t(active.qualityKey as StringKey),
                active.fileSizeGb,
              )}
            </span>
          </div>
          {changeModel}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {missingActiveId ? (
            <p className="text-ui text-ink-muted">{t('Ui_ModelMissing', missingActiveId)}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={onSetUp}>
              {t('RecordingSetup_SetUp')}
            </Button>
            {changeModel}
          </div>
        </div>
      )}

      <Dialog
        open={listOpen}
        onOpenChange={setListOpen}
        size="wide"
        title={t('Settings_SummaryModels.Header')}
        description={t('Settings_SummaryModels.Description')}
        closeLabel={t('Ui_Close')}
      >
        <div className="flex flex-col gap-3">
          {/* The page's own notice sits behind the dialog, so a model's failure shows here too. */}
          {model.problem ? (
            <Notice tone="warning" onDismiss={model.clearProblem} dismissLabel={t('Ui_Close')}>
              {model.problem}
            </Notice>
          ) : null}
          <LocalModels
            rows={rows}
            missingActiveId={missingActiveId}
            progress={model.progress}
            onSelect={model.selectModel}
            onDownload={(fileName) => {
              void model.downloadModel(fileName);
            }}
            onCancel={model.cancelModel}
            onDelete={model.deleteModel}
          />
        </div>
      </Dialog>
    </div>
  );
}
