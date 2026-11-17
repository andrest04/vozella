import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { MeetingList } from '../meeting-list/MeetingList';
import { orderProjectChoices } from '../meeting-list/project-order';
import { useConnectedProjectDirectory } from '../meeting-list/project-directory';
import { ALL_SCOPE, NONE_SCOPE, projectScope, type MeetingScope } from '../meeting-list/scope';
import { Notice, Select, type Option } from '../../ui';
import { setLibraryScope, useLibraryScope } from './library-scope-store';

const ALL_VALUE = 'all';
const NONE_VALUE = 'none';
const PROJECT_PREFIX = 'project:';

const valueOf = (scope: MeetingScope): string =>
  scope.kind === 'project'
    ? `${PROJECT_PREFIX}${scope.id}`
    : scope.kind === 'none'
      ? NONE_VALUE
      : ALL_VALUE;

const scopeOfValue = (value: string): MeetingScope =>
  value === NONE_VALUE
    ? NONE_SCOPE
    : value.startsWith(PROJECT_PREFIX)
      ? projectScope(value.slice(PROJECT_PREFIX.length))
      : ALL_SCOPE;

/** The Library: every meeting in one flat list, filtered by project when the reader asks. */
export function LibraryRoute() {
  const { t, locale } = useI18n();
  const directory = useConnectedProjectDirectory();
  const stored = useLibraryScope((state) => state.scope);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    void window.vozella.invoke('library.getLocation', {}).then((location) => {
      setStartupError(location.startupError);
    });
  }, []);

  // A project that is gone from the list no longer filters anything.
  const scope =
    stored.kind === 'project' &&
    directory.status === 'ready' &&
    !directory.projects.some((p) => p.id === stored.id)
      ? ALL_SCOPE
      : stored;

  const options = useMemo<readonly Option[]>(
    () => [
      { value: ALL_VALUE, label: t('Ui_LibraryAllProjects') },
      { value: NONE_VALUE, label: t('Ui_ProjectNone') },
      ...orderProjectChoices(directory.projects, locale).map((project) => ({
        value: `${PROJECT_PREFIX}${project.id}`,
        label: project.name,
      })),
    ],
    [directory.projects, locale, t],
  );
  const scopeName =
    scope.kind === 'project'
      ? (directory.projects.find((p) => p.id === scope.id)?.name ?? '')
      : t('Ui_ProjectNone');

  return (
    <MeetingList
      scope={scope}
      title={t('Ui_LibraryTitle')}
      scopeControl={
        <Select
          label={t('Ui_LibraryProjectFilter')}
          options={options}
          value={valueOf(scope)}
          onValueChange={(value) => {
            setLibraryScope(scopeOfValue(value));
          }}
          testId="library-project-filter"
        />
      }
      {...(scope.kind === 'all'
        ? {}
        : {
            onSearchAll: () => {
              setLibraryScope(ALL_SCOPE);
            },
            onClearScope: () => {
              setLibraryScope(ALL_SCOPE);
            },
            scopeName,
          })}
      notices={
        startupError ? (
          <Notice tone="warning">{t('Ui_LibraryMigrationFailed', startupError)}</Notice>
        ) : undefined
      }
    />
  );
}
