import { Link } from '@tanstack/react-router';
import { ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n, useT } from '../../i18n/I18nProvider';
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Notice,
  Select,
  SectionHeader,
  Skeleton,
  type Option,
} from '../../ui';
import { MigrationNotice } from './MigrationNotice';
import { NewProjectPopover } from './NewProjectPopover';
import { ProjectCard } from './ProjectCard';
import {
  PROJECT_SORTS,
  arrangeProjects,
  formatActivity,
  type ProjectSort,
} from './project-list-model';
import { setProjectPinned, useMigrationReport, useProjects } from './use-projects';

function SkeletonGrid() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t('Ui_Loading')}
      className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
    >
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex min-h-28 flex-col gap-2 rounded-overlay border border-hairline p-4"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="mt-auto h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Projects: a grid of cards with search and sort, the No project row, and the states of storage. */
export function ProjectsRoute() {
  const { t, locale } = useI18n();
  const directory = useProjects();
  const { report, dismiss } = useMigrationReport();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [problem, setProblem] = useState<string | null>(null);
  const now = Date.now();

  const arrangement = useMemo(
    () => arrangeProjects(directory.projects, { query, sort, locale }),
    [directory.projects, query, sort, locale],
  );
  const sortOptions = useMemo<readonly Option[]>(
    () =>
      PROJECT_SORTS.map((value) => ({
        value,
        label: t(
          value === 'recent'
            ? 'Ui_ProjectsSortRecent'
            : value === 'name'
              ? 'Ui_ProjectsSortName'
              : 'Ui_ProjectsSortNewest',
        ),
      })),
    [t],
  );

  const storage = directory.storage.status;
  const writable = storage === 'ready' && directory.status === 'ready';
  const loading = directory.status === 'loading';
  const preparing = storage === 'migrating';
  const noProjectCount = directory.noProject.meetingCount;
  const nothingAtAll =
    directory.status === 'ready' &&
    storage === 'ready' &&
    directory.projects.length === 0 &&
    noProjectCount === 0;
  const meetingsText = (count: number): string =>
    count === 1 ? t('Ui_ProjectMeetingsOne') : t('Ui_ProjectMeetingsMany', String(count));
  const unreadable = directory.skipped.length;

  const togglePin = (id: string, pinned: boolean): void => {
    setProblem(null);
    void setProjectPinned(id, !pinned).then((result) => {
      if (!result.ok) setProblem(t('Ui_ProjectActionFailed', result.message ?? result.reason));
    });
  };

  const card = (project: (typeof directory.projects)[number]) => (
    <li key={project.id}>
      <ProjectCard
        project={project}
        activity={formatActivity(project.lastActivityAt, locale, now)}
        meetings={meetingsText(project.meetingCount)}
        pinLabel={t('Ui_ProjectPinNamed', project.name)}
        pinDisabled={!writable}
        onTogglePin={() => {
          togglePin(project.id, project.pinned);
        }}
      />
    </li>
  );
  const grid = (items: readonly (typeof directory.projects)[number][]) => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      {items.map(card)}
    </ul>
  );
  const searching = query.trim() !== '';
  const noMatches =
    writable && searching && arrangement.pinned.length === 0 && arrangement.others.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        level={1}
        quiet
        title={t('Ui_ProjectsTitle')}
        action={nothingAtAll ? undefined : <NewProjectPopover disabled={!writable} />}
      />

      {report ? <MigrationNotice report={report} onDismiss={dismiss} /> : null}
      {storage === 'error' || directory.status === 'failed' ? (
        <Notice tone="warning" testId="projects-storage-error">
          <p>{t('Ui_ProjectsStorageError')}</p>
          {directory.storage.status === 'error' && directory.storage.message !== '' ? (
            <p className="text-ui text-ink-muted">{directory.storage.message}</p>
          ) : null}
        </Notice>
      ) : null}
      {storage === 'newer' ? (
        <Notice tone="warning" testId="projects-storage-newer">
          {t('Ui_ProjectsStorageNewer')}
        </Notice>
      ) : null}
      {problem ? (
        <Notice
          tone="warning"
          onDismiss={() => {
            setProblem(null);
          }}
          dismissLabel={t('Ui_Close')}
        >
          {problem}
        </Notice>
      ) : null}

      {loading ? (
        <SkeletonGrid />
      ) : preparing ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-read text-ink-muted">
            {t('Ui_ProjectsPreparing')}
          </p>
          <SkeletonGrid />
        </div>
      ) : nothingAtAll ? (
        <EmptyState
          message={t('Ui_ProjectsEmpty')}
          action={<NewProjectPopover disabled={false} />}
        />
      ) : (
        <>
          {writable && directory.projects.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-72 max-w-full">
                <Icon
                  icon={Search}
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
                />
                <Input
                  type="search"
                  aria-label={t('Ui_ProjectsSearch')}
                  placeholder={t('Ui_ProjectsSearch')}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  className="w-full pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searching ? (
                  <IconButton
                    label={t('Ui_ProjectsSearchClear')}
                    icon={X}
                    size="sm"
                    className="absolute top-1/2 right-0.5 -translate-y-1/2"
                    onClick={() => {
                      setQuery('');
                    }}
                  />
                ) : null}
              </div>
              <Select
                label={t('Ui_ProjectsSort')}
                options={sortOptions}
                value={sort}
                onValueChange={(value) => {
                  setSort(PROJECT_SORTS.find((candidate) => candidate === value) ?? 'recent');
                }}
              />
            </div>
          ) : null}

          {noProjectCount > 0 ? (
            <Link
              to="/projects/none"
              className="flex min-h-10 items-center gap-2 rounded-control border border-hairline px-3 text-ui-lg text-ink transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed"
            >
              <span className="font-medium">{t('Ui_ProjectNone')}</span>
              <span className="tabular font-mono text-caption text-ink-muted">
                {[
                  meetingsText(noProjectCount),
                  directory.noProject.lastActivityAt === null
                    ? ''
                    : formatActivity(directory.noProject.lastActivityAt, locale, now),
                ]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </span>
              <Icon icon={ChevronRight} size={14} className="ms-auto text-ink-faint" />
            </Link>
          ) : null}

          {noMatches ? (
            <EmptyState
              message={t('Ui_ProjectsSearchEmpty', query.trim())}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery('');
                  }}
                >
                  {t('Ui_ProjectsSearchClear')}
                </Button>
              }
            />
          ) : (
            <>
              {arrangement.pinned.length > 0 ? (
                <section aria-labelledby="projects-pinned" className="flex flex-col gap-3">
                  <h2 id="projects-pinned" className="text-heading font-semibold">
                    {t('Ui_ProjectsPinned')}
                  </h2>
                  {grid(arrangement.pinned)}
                </section>
              ) : null}
              {arrangement.others.length > 0 ? (
                <section aria-labelledby="projects-all" className="flex flex-col gap-3">
                  <h2 id="projects-all" className="text-heading font-semibold">
                    {t('Ui_ProjectsAll')}
                  </h2>
                  {grid(arrangement.others)}
                </section>
              ) : null}
            </>
          )}

          {unreadable > 0 ? (
            <p className="text-ui text-ink-muted">
              {unreadable === 1
                ? t('Ui_ProjectsUnreadableOne')
                : t('Ui_ProjectsUnreadableMany', String(unreadable))}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
