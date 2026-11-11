import { CircleArrowUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateState } from '@vozella/contracts';
import { useT } from '../../i18n/I18nProvider';
import { Button, Icon, IconButton, cn } from '../../ui';
import { popupColors } from '../../ui/styles';

/** "Remind me later" hides the card this long; a new launch shows it again at once. */
export const REMIND_LATER_MS = 4 * 60 * 60 * 1000;

/** The downloaded version, or null while nothing is ready to install. */
export function readyVersion(state: UpdateState | null): string | null {
  return state?.update.status === 'ready' ? state.update.version : null;
}

/** Main's update state: read once, then followed. */
function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.vozella.on('updates.stateChanged', (next) => {
      setState(next);
    });
    window.vozella
      .invoke('updates.getState', {})
      .then((next) => {
        if (alive) setState((current) => current ?? next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/**
 * True while a take records or is still being processed: an install must not cut it. Busy until
 * main answered, so the card never flashes over a running take. The exit gate still guards install.
 */
function useRecordingBusy(): boolean {
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let alive = true;
    const off = window.vozella.on('recording.state', (next) => {
      setBusy(next.isRecording || next.isProcessing);
    });
    window.vozella
      .invoke('recording.getState', {})
      .then((next) => {
        if (alive) setBusy(next.isRecording || next.isProcessing);
      })
      .catch(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return busy;
}

/**
 * The "new version" card, bottom left of the main window. It shows once an update has finished
 * downloading and no recording is running. Install now restarts into the new version; Remind me
 * later and close hide it for a few hours. The update still installs when the app quits.
 */
export function UpdateToast() {
  const t = useT();
  const state = useUpdateState();
  const recordingBusy = useRecordingBusy();
  const [snoozed, setSnoozed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!snoozed) return;
    const timer = setTimeout(() => {
      setSnoozed(false);
    }, REMIND_LATER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [snoozed]);

  const version = readyVersion(state);
  if (version === null || state === null || snoozed || recordingBusy) return null;

  const later = (): void => {
    setSnoozed(true);
    setFailed(false);
  };

  const install = (): void => {
    setInstalling(true);
    setFailed(false);
    void window.vozella
      .invoke('updates.install', {})
      .then((outcome) => {
        // Refused: the exit gate kept the app open (it asked about a recording). Try again later.
        if (outcome.status !== 'restarting') setInstalling(false);
        if (outcome.status === 'failed') setFailed(true);
      })
      .catch(() => {
        setInstalling(false);
        setFailed(true);
      });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-labelledby="UpdateToastTitle"
      data-testid="UpdateToast"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          later();
        }
      }}
      className={cn(
        popupColors,
        'app-no-drag fixed bottom-3 left-3 z-40 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2 rounded-overlay border p-3 shadow-overlay',
        'forced-colors:border-[CanvasText]',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon icon={CircleArrowUp} className="mt-0.5" />
        <p id="UpdateToastTitle" className="min-w-0 flex-1 text-ui-lg">
          <span className="font-medium">{t('Ui_UpdateReadyTitle')}</span>{' '}
          <span className="text-ink-muted">
            {t('Ui_UpdateReadyVersions', state.currentVersion, version)}
          </span>
        </p>
        <IconButton
          label={t('Ui_Close')}
          icon={X}
          size="sm"
          tooltip={false}
          onClick={later}
          className="-mt-0.5 -me-1"
        />
      </div>
      <p className="ps-[26px] text-ui text-ink-muted">{t('Ui_UpdateReadyBody')}</p>
      {failed ? (
        <p className="ps-[26px] text-ui text-ink-muted">{t('Ui_UpdateInstallFailed')}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={later}>
          {t('Ui_UpdateRemindLater')}
        </Button>
        <Button variant="secondary" size="sm" onClick={install} disabled={installing}>
          {t('Ui_UpdateInstallNow')}
        </Button>
      </div>
    </div>
  );
}
