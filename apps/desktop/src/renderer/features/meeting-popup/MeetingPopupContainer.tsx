import type { MeetingAppDto } from '@vozella/contracts';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { MeetingPopup, type PopupPhase } from '../../popup/MeetingPopup';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}

interface PopupView {
  readonly phase: PopupPhase;
  readonly showId: number;
  /** The call's app, when main named one. */
  readonly app: MeetingAppDto | undefined;
}

function viewAfterShow(current: PopupView, app: MeetingAppDto | undefined): PopupView {
  return { phase: prefersReducedMotion() ? 'shown' : 'in', showId: current.showId + 1, app };
}

/** The title names the app when it is known; an unknown or missing app keeps the generic copy. */
const TITLE_KEYS: Readonly<Record<MeetingAppDto, StringKey>> = {
  teams: 'MeetingPrompt_TitleTeams.Text',
  zoom: 'MeetingPrompt_TitleZoom.Text',
  meet: 'MeetingPrompt_TitleMeet.Text',
  unknown: 'MeetingPrompt_Title.Text',
};

type Action = 'meetingPrompt.start' | 'meetingPrompt.dismiss' | 'meetingPrompt.neverAgain';

/** Listens to main's show and hide events and sends the three buttons back through the bridge. */
export function MeetingPopupContainer() {
  const t = useT();
  const [view, setView] = useState<PopupView>({ phase: 'hidden', showId: 0, app: undefined });

  useEffect(() => {
    const appear = ({ app }: { app?: MeetingAppDto }): void => {
      // W9: every show restarts from a clean state, so the card is never left invisible.
      setView((current) => viewAfterShow(current, app));
    };
    const offShow = window.vozella.on('meetingPrompt.show', appear);
    const offHide = window.vozella.on('meetingPrompt.hide', ({ animated }) => {
      setView((current) => ({
        ...current,
        phase: animated && !prefersReducedMotion() ? 'out' : 'hidden',
      }));
    });
    // The page may have started after main sent its show: ask once, now that it is listening.
    void window.vozella
      .invoke('meetingPrompt.ready', {})
      .then(({ shown, app }) => {
        if (shown)
          setView((current) =>
            current.phase === 'hidden' ? viewAfterShow(current, app) : current,
          );
      })
      .catch(() => undefined);
    return () => {
      offShow();
      offHide();
    };
  }, []);

  const send = (name: Action): void => {
    void window.vozella.invoke(name, {}).catch(() => undefined);
  };

  return (
    <MeetingPopup
      phase={view.phase}
      showId={view.showId}
      title={t(TITLE_KEYS[view.app ?? 'unknown'])}
      subtitle={t('MeetingPrompt_Subtitle.Text')}
      startLabel={t('MeetingPrompt_Start.Content')}
      moreLabel={t('MeetingPrompt_More.AutomationProperties.Name')}
      dismissLabel={t('MeetingPrompt_Dismiss.Text')}
      neverAgainLabel={t('MeetingPrompt_NeverAgain.Text')}
      onStart={() => {
        send('meetingPrompt.start');
      }}
      onDismiss={() => {
        send('meetingPrompt.dismiss');
      }}
      onNeverAgain={() => {
        send('meetingPrompt.neverAgain');
      }}
      onHover={(inside) => {
        void window.vozella.invoke('meetingPrompt.hover', { inside }).catch(() => undefined);
      }}
    />
  );
}
