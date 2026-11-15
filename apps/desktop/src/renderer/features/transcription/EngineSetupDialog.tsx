import { INSTALL_STAGE_LABEL_KEYS } from '@vozella/core';
import { useCallback, useEffect, useRef } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, Dialog, Notice, Progress } from '../../ui';
import { overallPercent } from './live-lines';
import { useEngineInstall } from './use-engine-install';

/**
 * The record-time engine gate (spec 2.1, 2.2). It opens only when the engine is not on disk, starts
 * the download by itself and closes with `true` once the engine is ready. Cancel, Escape and the
 * close button all cancel the transfer and close with `false`; the caller then does not record.
 * A failure keeps the dialog open with the raw message and a Try again button.
 *
 * For a PC that cannot run the engine, the dialog also offers the way around it: transcribe in the
 * cloud with an API key. That choice cancels the transfer and calls `onUseCloud` instead of
 * `onFinished`; it changes no setting, and the caller takes the user to the engine choice.
 */
export function EngineSetupDialog({
  open,
  onFinished,
  onUseCloud,
}: {
  open: boolean;
  onFinished: (ready: boolean) => void;
  /** Without it the alternative is not drawn. */
  onUseCloud?: () => void;
}) {
  const t = useT();
  const install = useEngineInstall();
  const { start, cancel } = install;
  const finished = useRef(onFinished);
  finished.current = onFinished;
  // Each run of the dialog has a number. Closing it, or opening it again, retires the older runs,
  // so a cancelled answer that arrives late cannot close a dialog that was opened afterwards.
  const run = useRef(0);

  const begin = useCallback(() => {
    run.current += 1;
    const mine = run.current;
    void start().then((outcome) => {
      if (mine !== run.current) return;
      if (outcome.status === 'ready') finished.current(true);
      else if (outcome.status === 'cancelled') finished.current(false);
    });
  }, [start]);

  useEffect(() => {
    if (open) begin();
  }, [open, begin]);

  const close = (): void => {
    run.current += 1;
    void cancel();
    finished.current(false);
  };

  const useCloud = (): void => {
    run.current += 1;
    void cancel();
    onUseCloud?.();
  };

  const failed = install.phase === 'failed';
  const progress = install.progress;
  const stage = progress ? t(INSTALL_STAGE_LABEL_KEYS[progress.stage] as StringKey) : null;
  const status = stage ?? t('Status_PreparingDownload');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('EngineSetup.Title')}
      description={t('EngineSetup_Hint.Text')}
      closeLabel={t('Ui_Close')}
      actions={
        <>
          {failed ? <Button onClick={begin}>{t('Ui_XaiRetry')}</Button> : null}
          <Button variant={failed ? 'secondary' : 'primary'} onClick={close}>
            {t('EngineSetup.CloseButtonText')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="engine-setup">
        {failed ? null : (
          <Progress
            label={t('Ui_EngineProgressName')}
            value={progress ? overallPercent(progress) : null}
            showValue={progress !== null}
          />
        )}
        {failed ? null : (
          <p className="text-ui-lg text-ink" role="status" data-testid="engine-setup-status">
            {status}
          </p>
        )}
        {progress && progress.stepCount > 1 && !failed ? (
          <p className="text-ui text-ink-muted">
            {t('Ui_EngineStep', progress.stepIndex + 1, progress.stepCount)}
          </p>
        ) : null}
        {failed && install.error ? (
          <Notice tone="warning">
            <span className="block font-medium">{t('EngineSetup_Failed.Title')}</span>
            <span className="block text-ink-muted">{install.error}</span>
          </Notice>
        ) : null}
        {onUseCloud ? (
          // Set apart and small: the download is the way most people go.
          <div className="flex flex-col items-start gap-2 border-t border-hairline pt-3">
            <p className="text-ui text-ink-muted">{t('Ui_EngineSetupCloudHint')}</p>
            <Button size="sm" onClick={useCloud}>
              {t('Ui_EngineSetupUseCloud')}
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
