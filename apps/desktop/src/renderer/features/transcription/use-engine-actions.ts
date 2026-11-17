import type { InstallOutcomeDto } from '@vozella/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

export interface EngineActions {
  /** The failure of the last download or delete, ready to show, or null. */
  readonly note: string | null;
  /** `local`: the engine on this PC, asked for by name while a cloud engine is selected. */
  readonly download: (options?: { readonly local?: boolean }) => Promise<void>;
  readonly remove: () => Promise<void>;
  /** Turns live captions on or off; failures only show as the refreshed status. */
  readonly setLive: (enabled: boolean) => void;
}

export interface EngineActionsOptions {
  /** The shared engine download from `useEngineInstall`. */
  readonly start: (options?: { readonly local?: boolean }) => Promise<InstallOutcomeDto>;
  /** Reloads the engine status after every action. */
  readonly refresh: () => Promise<unknown>;
  /** Speaks an outcome through the section's polite live region. */
  readonly announce: (message: string) => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the Settings engine row does: download through the shared install, delete the
 * engine files, and switch live captions. Keeps the failure text the row shows under the engine.
 */
export function useEngineActions({
  start,
  refresh,
  announce,
}: EngineActionsOptions): EngineActions {
  const { t } = useI18n();
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const download = useCallback(
    async (options?: { readonly local?: boolean }) => {
      setNote(null);
      const outcome = await start(options);
      if (outcome.status === 'failed') {
        setNote(t('Error_DownloadFailedCaption', outcome.message));
      }
      await refresh();
    },
    [start, refresh, t],
  );

  const remove = useCallback(async () => {
    setNote(null);
    try {
      const { outcome } = await window.vozella.invoke('transcription.deleteEngine', {});
      if (outcome === 'RuntimeInUse') setNote(t('Error_EngineDeleteInUse'));
      else if (outcome === 'Incomplete') setNote(t('Error_EngineDeleteIncomplete'));
      else if (alive.current) announce(t('Ui_EngineDeleted'));
    } catch (error) {
      setNote(t('Error_DownloadFailedCaption', errorText(error)));
    }
    await refresh();
  }, [refresh, announce, t]);

  const setLive = useCallback(
    (enabled: boolean): void => {
      void window.vozella
        .invoke('transcription.setLiveEnabled', { enabled })
        .catch(() => undefined)
        .then(refresh);
    },
    [refresh],
  );

  return { note, download, remove, setLive };
}
