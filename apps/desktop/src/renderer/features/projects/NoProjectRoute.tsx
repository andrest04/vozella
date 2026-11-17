import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { Icon } from '../../ui';
import { NONE_SCOPE } from '../meeting-list/scope';
import { ProjectTabs } from './ProjectTabs';

/** `/projects/none`: the meetings and chats that belong to no project. */
export function NoProjectRoute() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <Link
        to="/projects"
        className="inline-flex w-fit items-center gap-1 rounded-control text-ui text-ink-muted transition-colors duration-150 ease-out-quick hover:text-ink"
      >
        <Icon icon={ChevronLeft} size={14} />
        {t('Ui_ProjectsTitle')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-[-0.01em]">{t('Ui_ProjectNone')}</h1>
        <p className="text-read text-ink-muted">{t('Ui_ProjectNoneSubtitle')}</p>
      </header>
      <ProjectTabs scope={NONE_SCOPE} owner={null} />
    </div>
  );
}
