import type { MigrationReportDto } from '@vozella/contracts';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, Disclosure, Notice } from '../../ui';

/** Where an older layout was found, in words and never as a path. */
const LEFTOVER_KEYS: Readonly<Record<string, StringKey>> = {
  'meetings-folder': 'Ui_MigrationLeftoverMeetings',
  'recordings-folder': 'Ui_MigrationLeftoverRecordings',
  'meetings-json': 'Ui_MigrationLeftoverList',
};

export interface MigrationNoticeProps {
  readonly report: MigrationReportDto;
  readonly onDismiss: () => void;
}

/**
 * Said once, after the folders became projects: how many, which were renamed, and anything that
 * was left out. The renamed list is there on demand, and Dismiss ends the notice for good.
 */
export function MigrationNotice({ report, onDismiss }: MigrationNoticeProps) {
  const t = useT();
  const renamed = report.renamed.length;
  const skipped = report.skipped.length;
  const leftovers = report.legacyLeftovers.map((id) =>
    t(LEFTOVER_KEYS[id] ?? 'Ui_MigrationLeftoverOther'),
  );
  return (
    <Notice testId="migration-notice">
      <div className="flex flex-col gap-2">
        <p>
          {report.projects === 1
            ? t('Ui_MigrationProjectsOne')
            : t('Ui_MigrationProjectsMany', String(report.projects))}
          {renamed === 0
            ? ''
            : ' ' +
              (renamed === 1
                ? t('Ui_MigrationRenamedOne')
                : t('Ui_MigrationRenamedMany', String(renamed)))}
        </p>
        {skipped === 0 ? null : (
          <p>
            {skipped === 1
              ? t('Ui_MigrationSkippedOne')
              : t('Ui_MigrationSkippedMany', String(skipped))}
          </p>
        )}
        {leftovers.length === 0 ? null : <p>{t('Ui_MigrationLeftovers', leftovers.join(', '))}</p>}
        {renamed === 0 ? null : (
          <Disclosure title={t('Ui_MigrationShowRenamed')} className="border-b-0">
            <ul className="flex flex-col gap-1 text-ui">
              {report.renamed.map((item) => (
                <li key={item.id}>{t('Ui_MigrationRenamedItem', item.from, item.to)}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        <div>
          <Button size="sm" onClick={onDismiss}>
            {t('Ui_Dismiss')}
          </Button>
        </div>
      </div>
    </Notice>
  );
}
