import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

export type SpeakerBusy = 'download' | 'delete' | null;

export interface SpeakerModel {
  /** Which action runs now; one at a time. */
  readonly busy: SpeakerBusy;
  /** The speaker model download percent, while `busy` is `download`. */
  readonly percent: number;
  /** The failure of the last action, ready to show, or null. */
  readonly note: string | null;
  /** Turns speaker labels on (downloads the model if needed) or off. */
  readonly setLabels: (enabled: boolean) => void;
  readonly download: () => void;
  readonly remove: () => void;
}

export interface SpeakerModelOptions {
  /** Reloads the engine status after every action. */
  readonly refresh: () => Promise<unknown>;
  /** Speaks an outcome through the section's polite live region. */
  readonly announce: (message: string) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The speaker labels switch and the model it needs (spec 2.6): download, delete and the switch run
 * one at a time, follow the shared install progress for the speaker model stage, and keep the
 * failure text for the row below.
 */
export function useSpeakerModel({ refresh, announce }: SpeakerModelOptions): SpeakerModel {
  const { t } = useI18n();
  const [busy, setBusy] = useState<SpeakerBusy>(null);
  const [percent, setPercent] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const off = window.vozella.on('transcription.installProgress', (progress) => {
      if (alive.current && progress.stage === 'speaker-model' && running.current) {
        setPercent(Math.round(progress.percent));
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, []);

  /** Runs one speaker model action; `action` answers the failure message or null. */
  const run = useCallback(
    async (action: () => Promise<string | null>, kind: 'download' | 'delete' = 'download') => {
      if (running.current) return;
      running.current = true;
      setBusy(kind);
      setPercent(0);
      setNote(null);
      let failure: string | null;
      try {
        failure = await action();
      } catch (error) {
        failure = errorText(error);
      }
      running.current = false;
      if (alive.current) {
        setBusy(null);
        setPercent(0);
        setNote(
          failure === null
            ? null
            : kind === 'delete'
              ? t('Ui_SpeakerDeleteFailed', failure)
              : `${t('Error_DownloadFailedCaption', failure)} ${t('Ui_SpeakerModelFailed')}`,
        );
      }
      await refresh();
    },
    [refresh, t],
  );

  const setLabels = useCallback(
    (enabled: boolean): void => {
      void run(
        async () => {
          const result = await window.vozella.invoke('transcription.setSpeakerLabels', {
            enabled,
          });
          return result.status === 'failed' ? result.message : null;
        },
        enabled ? 'download' : 'delete',
      );
    },
    [run],
  );

  const download = useCallback((): void => {
    void run(async () => {
      const result = await window.vozella.invoke('transcription.downloadSpeakerModel', {});
      return result.status === 'failed' ? result.message : null;
    });
  }, [run]);

  const remove = useCallback((): void => {
    void run(async () => {
      const result = await window.vozella.invoke('transcription.deleteSpeakerModel', {});
      if (result.status === 'failed') return result.message;
      if (alive.current) announce(t('Ui_SpeakerDeleted'));
      return null;
    }, 'delete');
  }, [run, announce, t]);

  return { busy, percent, note, setLabels, download, remove };
}
