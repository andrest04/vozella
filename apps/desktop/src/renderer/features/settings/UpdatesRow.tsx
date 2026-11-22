import { CircleAlert, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { UpdateState } from '@vozella/contracts';
import { useI18n } from '../../i18n/I18nProvider';
import type { Translate } from '../../i18n/translate';
import { Button, Icon, SkeletonText, cn } from '../../ui';
import { useUpdateState } from '../updates/use-update-state';

/** What this row adds on top of main's state: a request in flight, or a reply worth saying. */
type Pending = 'check' | 'install' | null;
type Notice = 'disabled' | 'checkFailed' | 'installFailed' | null;

interface RowView {
  readonly message: string;
  readonly failed: boolean;
  readonly action: 'check' | 'install';
  readonly actionDisabled: boolean;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The time of the last answer, with the day only when it was not today. 24 hour clock. */
export function formatCheckedAt(ms: number, now: number, locale: string): string {
  const at = new Date(ms);
  const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
  const options: Intl.DateTimeFormatOptions = sameDay(at, new Date(now))
    ? time
    : { day: 'numeric', month: 'short', ...time };
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, options).format(at);
}

function view(
  state: UpdateState,
  pending: Pending,
  notice: Notice,
  t: Translate,
  locale: string,
): RowView {
  const check = (message: string, actionDisabled = false, failed = false): RowView => ({
    message,
    failed,
    action: 'check',
    actionDisabled,
  });
  const update = state.update;
  if (update.status === 'ready') {
    return {
      message:
        notice === 'installFailed'
          ? t('Ui_UpdateInstallFailed')
          : t('Ui_UpdateReadyToInstall', update.version),
      failed: notice === 'installFailed',
      action: 'install',
      actionDisabled: pending === 'install',
    };
  }
  if (pending === 'check' || update.status === 'checking')
    return check(t('Ui_UpdateChecking'), true);
  if (update.status === 'available') return check(t('Ui_UpdateFound', update.version), true);
  if (update.status === 'downloading') {
    return check(t('Ui_UpdateDownloading', update.version, String(update.percent)), true);
  }
  if (notice === 'disabled') return check(t('Ui_UpdatesOffInBuild'));
  if (notice === 'checkFailed' || update.status === 'error') {
    // The updater's own message is technical (net::ERR_…); it stays in the log.
    return check(t('Ui_UpdateCheckFailed'), false, true);
  }
  if (state.lastCheckedAt === undefined) return check(t('Ui_UpdateNotCheckedYet'));
  return check(t('Ui_UpdateUpToDate', formatCheckedAt(state.lastCheckedAt, Date.now(), locale)));
}

/**
 * "Check for updates" under the version in About. Main runs the check and owns the state; the row
 * follows it, says the outcome in a polite live region, and offers the install once a download is
 * ready, the same request the update card uses.
 */
export function UpdatesRow() {
  const { t, locale } = useI18n();
  const state = useUpdateState();
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const title = t('Ui_AboutUpdates');

  const checkNow = (): void => {
    setPending('check');
    setNotice(null);
    window.vozella
      .invoke('updates.check', {})
      .then((outcome) => {
        if (outcome.status === 'disabled') setNotice('disabled');
      })
      .catch(() => {
        setNotice('checkFailed');
      })
      .finally(() => {
        setPending(null);
      });
  };

  const installNow = (): void => {
    setPending('install');
    setNotice(null);
    window.vozella
      .invoke('updates.install', {})
      .then((outcome) => {
        // Restarting: the app quits. Refused: the exit gate asked about a recording; try later.
        if (outcome.status === 'failed') setNotice('installFailed');
        if (outcome.status !== 'restarting') setPending(null);
      })
      .catch(() => {
        setNotice('installFailed');
        setPending(null);
      });
  };

  const row = state === null ? null : view(state, pending, notice, t, locale);

  return (
    <div
      role="group"
      aria-label={title}
      className="flex flex-col gap-1.5 border-b border-hairline py-3.5 last:border-b-0"
    >
      <div className="flex min-h-8 items-center justify-between gap-6">
        <span className="text-ui-lg font-medium text-ink">{title}</span>
        {row?.action === 'install' ? (
          <Button onClick={installNow} disabled={row.actionDisabled}>
            {t('Ui_UpdateInstallNow')}
          </Button>
        ) : (
          <Button icon={RefreshCw} onClick={checkNow} disabled={row === null || row.actionDisabled}>
            {t('Ui_UpdateCheckNow')}
          </Button>
        )}
      </div>
      {/* Always mounted, so a screen reader hears each change of the outcome. */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-start gap-1.5 text-ui',
          row?.failed ? 'text-ink' : 'text-ink-muted',
        )}
      >
        {row === null ? <SkeletonText lines={1} className="w-48" /> : null}
        {row?.failed ? <Icon icon={CircleAlert} size={14} className="mt-[3px]" /> : null}
        {row ? <span>{row.message}</span> : null}
      </div>
    </div>
  );
}
