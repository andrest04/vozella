import type { MeetingListItemDto } from '@vozella/contracts';
import { ArrowRightLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { matchLibraryShortcut } from '../../app/shortcuts';
import { useI18n } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, ConfirmDialog, EmptyState, Notice, Skeleton, cn } from '../../ui';
import { BulkBar } from './BulkBar';
import { describeSkipped } from './format';
import { HEADER_ROW_PX, MEETING_ROW_PX, nextCursor } from './logbook';
import { ListHeader } from './ListHeader';
import { MeetingGrid } from './MeetingGrid';
import { FilterButton, FilterChips } from './MeetingFilterControls';
import { MeetingPreview } from './MeetingPreview';
import { NO_FILTERS, filterKey, isFiltering, type MeetingFilters } from './meeting-filters';
import {
  refreshMeetingList,
  rememberScroll,
  resetPosition,
  setCursor,
  setFilters,
  useMeetingListStore,
} from './meeting-list-store';
import { MoveToProjectPopover } from './MoveToProjectPopover';
import { RenameDialog } from './RenameDialog';
import { scopeKey, type MeetingScope } from './scope';
import { tabOfHit } from './search-results';
import { UndoOffer } from './UndoOffer';
import { useBulkActions } from './use-bulk-actions';
import { useListFocus } from './use-list-focus';
import { useMeetingList, type StatusMessage } from './use-meeting-list';
import {
  confirmText,
  useMeetingListDialogs,
  useMeetingRename,
  type ConfirmDialogState,
} from './use-meeting-list-dialogs';
import { useMeetingPreview } from './use-meeting-preview';
import { useProjectDirectory } from './project-directory';

type MoveSource = 'row' | 'bar' | 'preview';

/** From this width of the list the preview sits beside it; below it a click opens. */
export const PANED_LAYOUT_PX = 760;

function useWideLayout(): { ref: React.RefObject<HTMLElement | null>; wide: boolean } {
  const ref = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => {
      setWide(element.clientWidth >= PANED_LAYOUT_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, wide };
}

export interface MeetingListProps {
  readonly scope: MeetingScope;
  /** The name of the list, or null where the page around it already says it. */
  readonly title: string | null;
  /** Beside the search: what picks the scope, where the list has such a control. */
  readonly scopeControl?: ReactNode;
  /** Widens the search to every meeting. Absent where the list already covers everything. */
  readonly onSearchAll?: () => void;
  /** For a project scope the library filters by: what the empty message names, and the way out. */
  readonly scopeName?: string;
  readonly onClearScope?: () => void;
  /** Shown with the empty message of a project that has no meetings: the way to start one. */
  readonly projectEmptyAction?: ReactNode;
  /** Page level notices placed above the rows. */
  readonly notices?: ReactNode;
  readonly className?: string;
}

/**
 * The meetings of one scope: header with search and filters, the rows, the bulk bar, the preview
 * beside the list when there is room, and the dialogs. The Library and the project pages both
 * render this, so a list behaves the same wherever it is.
 */
export function MeetingList({
  scope,
  title,
  scopeControl,
  onSearchAll,
  scopeName,
  onClearScope,
  projectEmptyAction,
  notices,
  className,
}: MeetingListProps) {
  const { t, locale } = useI18n();
  const model = useMeetingList(scope);
  const directory = useProjectDirectory();
  const { ref: layoutRef, wide } = useWideLayout();
  const [skippedDismissed, setSkippedDismissed] = useState(false);
  const viewKey = scopeKey(scope);

  const projectName = (id: string | null): string =>
    id === null
      ? t('Ui_ProjectNone')
      : (directory.projects.find((p) => p.id === id)?.name ?? t('Ui_ProjectNone'));

  const dialogs = useMeetingListDialogs();
  const { dialog, shown, openDialog, closeDialog } = dialogs;
  const dialogChrome = {
    cancelLabel: '',
    closeLabel: t('Ui_Close'),
    onOpenChange: (open: boolean): void => {
      if (!open) closeDialog();
    },
  };

  const cursorId = useMeetingListStore((state) => state.cursorId);
  const listedIds = useMemo(() => model.meetings.map((m) => m.id), [model.meetings]);
  const lastListed = useRef<readonly string[]>([]);
  // The preview needs a row: the newest at first, the neighbor when the row went away.
  useEffect(() => {
    const previous = lastListed.current;
    lastListed.current = listedIds;
    // `wide` starts true, and a list already loaded gets here before that measure takes effect.
    const width = layoutRef.current?.clientWidth ?? PANED_LAYOUT_PX;
    if (!wide || width < PANED_LAYOUT_PX || model.isLoading) return;
    const next = nextCursor(useMeetingListStore.getState().cursorId, previous, listedIds);
    if (next !== useMeetingListStore.getState().cursorId) setCursor(next);
  }, [listedIds, wide, model.isLoading, cursorId, layoutRef]);

  // Another scope is another list, which starts at the top.
  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    resetPosition();
  }, [viewKey]);

  const filters = useMeetingListStore((state) => state.filters);
  const filtering = isFiltering(filters);
  const filtersKey = filterKey(filters);

  // After a keyboard delete the row with the focus is gone: the focus goes on to its neighbor.
  const { gridRef, setFromKeyboard, afterWork } = useListFocus({
    dialogOpen: dialog !== null,
    cursorId,
    listedIds,
  });
  const searchRef = useRef<HTMLInputElement>(null);

  const bulk = useBulkActions({
    library: model,
    listedIds,
    t,
    placeName: projectName,
    listKey: `${viewKey}|${model.query}|${filtersKey}`,
    openDialog,
    afterWork,
  });
  const { checks, bulkWork, undoMove } = bulk;

  const rename = useMeetingRename({
    t,
    refresh: refreshMeetingList,
    onRenamed: () => {
      closeDialog();
      afterWork();
    },
  });

  // Move to project: one popover each for the rows, the bar and the preview, all driven from here.
  const [move, setMove] = useState<{
    readonly source: MoveSource;
    readonly meetings: readonly MeetingListItemDto[];
  } | null>(null);
  const rowAnchor = useRef<Element | null>(null);
  const askMove = (source: MoveSource, meetings: readonly MeetingListItemDto[]): void => {
    const [first] = meetings;
    if (!first) return;
    rowAnchor.current =
      layoutRef.current?.querySelector(`[data-row-id="${first.id}"]`) ?? layoutRef.current;
    setMove({ source, meetings });
  };
  const runMove = (projectId: string | null): void => {
    if (!move) return;
    const { meetings } = move;
    if (meetings.length === 1 && meetings[0]) {
      const only = meetings[0];
      void model.moveMeeting(only.id, projectId).then((moved) => {
        if (moved && only.projectId !== projectId) bulk.offerUndo([only], projectId);
      });
    } else {
      void bulk.runMoveMany(meetings, projectId);
    }
  };
  const movePopover = (source: MoveSource, trigger: React.ReactElement): ReactNode => (
    <MoveToProjectPopover
      open={move?.source === source}
      onOpenChange={(open) => {
        if (!open) {
          setMove(null);
          if (source === 'row') afterWork();
        }
      }}
      trigger={trigger}
      {...(source === 'row' ? { anchor: rowAnchor } : {})}
      from={move?.meetings.map((m) => m.projectId) ?? []}
      onMove={runMove}
    />
  );

  const onRowKey = (
    action: 'toggle' | 'rename' | 'delete' | 'deletePermanently' | 'clear',
    id: string,
  ): void => {
    const meeting = model.meetings.find((m) => m.id === id);
    if (action === 'clear') {
      if (checks.checked.size > 0) bulk.clearChecks();
      else model.setQuery('');
    } else if (!meeting) {
      return;
    } else if (action === 'toggle') {
      bulk.toggleCheck(id);
    } else if (action === 'rename') {
      setFromKeyboard(true);
      rename.clearProblem();
      openDialog({ kind: 'renameMeeting', meeting });
    } else {
      setFromKeyboard(true);
      bulk.askDelete(bulk.targetsOf(meeting), action === 'deletePermanently');
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (matchLibraryShortcut(event) !== 'librarySearch') return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const text = (message: StatusMessage): string => t(message.key, ...message.args);

  /** What yes does in each confirmation. */
  const runConfirm = (confirmed: ConfirmDialogState): void => {
    switch (confirmed.kind) {
      case 'deleteMany':
        void bulk.runDeleteMany(confirmed.meetingIds, 'trash');
        return;
      case 'deleteManyPermanently':
        void bulk.runDeleteMany(confirmed.meetingIds, 'permanent');
        return;
      case 'deleteMeeting': {
        const { meeting } = confirmed;
        void model.deleteMeeting(meeting.id).then((outcome) => {
          if (outcome === 'trash-failed') {
            openDialog({ kind: 'deleteMeetingPermanently', meeting, refused: true });
          }
          afterWork();
        });
        return;
      }
      case 'deleteMeetingPermanently':
        void model.deleteMeeting(confirmed.meeting.id, 'permanent').then(afterWork);
        return;
    }
  };
  const confirm = dialogs.confirm === null ? null : confirmText(dialogs.confirm);

  // A chip that goes takes the focus with it, so the focus goes to the button that made it.
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const changeFiltersFromList = (next: MeetingFilters): void => {
    setFilters(next);
    filterButtonRef.current?.focus();
  };

  const previewId = wide && cursorId !== null && listedIds.includes(cursorId) ? cursorId : null;
  const preview = useMeetingPreview(previewId);
  const previewMeeting = previewId === null ? null : model.meetings.find((m) => m.id === previewId);

  const gridLabels = useMemo(
    () => ({
      grid: t('HistoryPage_Title.Text'),
      noContent: t('History_NoContent'),
      more: t('HistoryRow_More.AutomationProperties.Name'),
      openSummary: t('HistoryRow_OpenSummary'),
      move: t('Ui_MoveToProject'),
      remove: t('HistoryRow_Delete'),
      today: t('Ui_LibraryToday'),
      yesterday: t('Ui_LibraryYesterday'),
      noDate: t('Ui_LibraryNoDate'),
      duration: (minutes: number) => t('Ui_LibraryDurationMinutes', String(minutes)),
      checkMeeting: (title: string) => t('Ui_LibraryCheckMeeting', title),
      checkDay: (day: string) => t('Ui_LibraryCheckDay', day),
    }),
    [t],
  );

  const emptyMessage: StringKey | null =
    model.empty === 'library'
      ? 'HistoryPage_Empty.Text'
      : model.empty === 'none'
        ? 'Library_InboxEmpty.Text'
        : model.empty === 'project'
          ? onClearScope
            ? null
            : 'Library_FolderEmpty.Text'
          : model.empty === 'filters'
            ? 'Ui_LibraryFilterEmpty'
            : model.empty === 'no-matches'
              ? 'Ui_LibrarySearchEmpty'
              : null;
  const emptyText =
    model.empty === 'project' && onClearScope
      ? t('Ui_LibraryProjectFilterEmpty', scopeName ?? '')
      : emptyMessage
        ? t(emptyMessage)
        : null;
  const searchStatus = model.searching
    ? t('Ui_LibrarySearching')
    : model.searchFailed
      ? t('Ui_LibrarySearchTitlesOnly')
      : t('Ui_LibrarySearchMatches', String(model.meetings.length));
  const stillLoading = model.isLoading;

  return (
    <section ref={layoutRef} className={cn('flex min-h-0 flex-1', className)}>
      <div
        data-testid="library-list-pane"
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          wide ? 'w-[clamp(340px,38%,440px)] shrink-0 border-e border-hairline' : 'flex-1',
        )}
      >
        <ListHeader
          title={title}
          {...(scopeControl === undefined ? {} : { scopeControl })}
          count={model.scopeCount}
          countText={
            filtering
              ? t(
                  'Ui_LibraryFilteredCount',
                  String(model.meetings.length),
                  String(model.scopeCount),
                )
              : String(model.scopeCount)
          }
          filterButton={
            <FilterButton filters={filters} onChange={setFilters} buttonRef={filterButtonRef} />
          }
          filterChips={
            <FilterChips
              filters={filters}
              onChange={changeFiltersFromList}
              showClear={!model.filtersHideAll}
            />
          }
          filterResults={
            filtering
              ? t(
                  'Ui_LibraryFilterResultsLine',
                  String(model.meetings.length),
                  String(model.scopeCount),
                )
              : ''
          }
          filterResultsLabel={t('Ui_LibraryFilterResults')}
          query={model.query}
          searchLabel={t('Library_Search.PlaceholderText')}
          searchRef={searchRef}
          onSearchKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              model.setQuery('');
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              gridRef.current?.focusCursor();
            }
          }}
          clearSearchLabel={t('Ui_LibrarySearchClear')}
          onQueryChange={model.setQuery}
          searchStatus={searchStatus}
          searchAll={
            onSearchAll ? { label: t('Ui_LibrarySearchAll'), onSelect: onSearchAll } : null
          }
        />

        <div className="flex shrink-0 flex-col gap-2 px-4 empty:hidden">
          {notices}
          {model.problem ? (
            <Notice tone="warning">
              {model.problem.reason === 'corrupt'
                ? t('Ui_LibraryFoldersDamaged', model.problem.message ?? '')
                : t('Ui_LibraryFolderFailed', model.problem.message ?? model.problem.reason)}
            </Notice>
          ) : null}
          {model.skipped.length > 0 && !skippedDismissed ? (
            <Notice
              onDismiss={() => {
                setSkippedDismissed(true);
              }}
              dismissLabel={t('Ui_Close')}
            >
              {t('Ui_LibrarySkippedFiles', describeSkipped(model.skipped))}
            </Notice>
          ) : null}
          {model.status ? (
            <Notice tone="warning" onDismiss={model.dismissStatus} dismissLabel={t('Ui_Close')}>
              {text(model.status)}
            </Notice>
          ) : null}
        </div>

        {checks.checked.size > 0 || bulkWork !== null ? (
          <BulkBar
            label={t('Ui_LibraryBulkLabel')}
            status={
              bulkWork === null
                ? t('Ui_LibraryBulkChecked', String(checks.checked.size))
                : t(
                    bulkWork.kind === 'moving' ? 'Ui_LibraryBulkMoving' : 'Ui_LibraryBulkDeleting',
                    String(bulkWork.count),
                  )
            }
            busy={bulkWork !== null}
            move={movePopover(
              'bar',
              <Button
                size="sm"
                variant="quiet"
                icon={ArrowRightLeft}
                disabled={bulkWork !== null}
                onClick={() => {
                  askMove('bar', bulk.checkedMeetings);
                }}
              >
                {t('Ui_MoveToProject')}
              </Button>,
            )}
            deleteLabel={t('HistoryRow_Delete')}
            clearLabel={t('Ui_LibraryBulkClear')}
            onDelete={() => {
              setFromKeyboard(false);
              bulk.askDelete(bulk.checkedMeetings, false);
            }}
            onClear={() => {
              bulk.clearChecks();
            }}
          />
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {undoMove ? (
            <UndoOffer
              message={undoMove.message}
              undoLabel={t('Ui_LibraryUndo')}
              dismissLabel={t('Ui_LibraryUndoDismiss')}
              onUndo={() => {
                void bulk.runUndo(undoMove);
              }}
              onDismiss={bulk.dismissUndo}
            />
          ) : null}
          {stillLoading ? (
            <div role="status" aria-label={t('Ui_Loading')} className="flex flex-col">
              <div
                style={{ height: HEADER_ROW_PX }}
                className="flex items-center border-b border-hairline ps-4"
              >
                <Skeleton className="h-3 w-24" />
              </div>
              {[0, 1, 2, 3, 4].map((row) => (
                <div
                  key={row}
                  style={{ height: MEETING_ROW_PX }}
                  className="flex items-center border-b border-hairline ps-4 pe-3"
                >
                  <Skeleton className="h-3 w-10 shrink-0" />
                  <div className="ms-8 flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-3 w-2/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : model.meetings.length > 0 ? (
            <MeetingGrid
              handle={gridRef}
              key={`${viewKey}-${filtersKey}`}
              meetings={model.meetings}
              locale={locale}
              labels={gridLabels}
              query={model.query}
              hits={model.hits}
              cursorId={cursorId}
              clickOpens={!wide}
              initialScrollOffset={useMeetingListStore.getState().scrollOffset}
              checked={checks.checked}
              onToggleCheck={(id) => {
                bulk.toggleCheck(id);
              }}
              onExtendChecks={bulk.onExtendChecks}
              onSetDayChecks={(ids, on) => {
                bulk.setDayChecks(ids, on);
              }}
              onCursorChange={setCursor}
              onScrollOffsetChange={rememberScroll}
              onOpen={(id) => {
                model.openMeeting(id, tabOfHit(model.hits.get(id)) ?? 'Transcript');
              }}
              onOpenSummary={(id) => {
                model.openMeeting(id, 'Summary');
              }}
              onMove={(meeting) => {
                setFromKeyboard(false);
                askMove('row', bulk.targetsOf(meeting));
              }}
              onDelete={(meeting) => {
                setFromKeyboard(false);
                bulk.askDelete(bulk.targetsOf(meeting), false);
              }}
              onRowKey={onRowKey}
              onSelectAll={bulk.selectAll}
            />
          ) : emptyText ? (
            <div className="px-4">
              <EmptyState
                message={emptyText}
                action={
                  model.empty === 'library' ? (
                    <Button onClick={model.goRecord}>{t('HistoryPage_EmptyCta.Content')}</Button>
                  ) : model.empty === 'filters' ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        changeFiltersFromList(NO_FILTERS);
                      }}
                    >
                      {t('Ui_LibraryFilterClear')}
                    </Button>
                  ) : model.empty === 'project' ? (
                    onClearScope ? (
                      <Button size="sm" onClick={onClearScope}>
                        {t('Ui_LibraryProjectFilterClear')}
                      </Button>
                    ) : (
                      (projectEmptyAction ?? undefined)
                    )
                  ) : undefined
                }
              />
            </div>
          ) : null}
        </div>
      </div>
      {wide ? (
        <section
          data-testid="library-preview"
          aria-label={t('Ui_LibraryPreview')}
          className="flex min-w-0 flex-1 flex-col"
        >
          <MeetingPreview
            state={preview}
            preferredTab={previewId === null ? null : tabOfHit(model.hits.get(previewId))}
            onOpen={model.openMeeting}
            {...(previewMeeting
              ? {
                  moveControl: movePopover(
                    'preview',
                    <Button
                      size="sm"
                      icon={ArrowRightLeft}
                      onClick={() => {
                        askMove('preview', [previewMeeting]);
                      }}
                    >
                      {t('Ui_MoveToProject')}
                    </Button>,
                  ),
                }
              : {})}
          />
        </section>
      ) : null}

      {movePopover(
        'row',
        <button type="button" tabIndex={-1} aria-hidden="true" className="sr-only" />,
      )}
      <ConfirmDialog
        {...dialogChrome}
        open={dialogs.confirmOpen}
        title={confirm ? text(confirm.title) : ''}
        description={confirm ? text(confirm.description) : ''}
        cancelLabel={confirm ? t(confirm.cancel) : ''}
        primaryLabel={confirm ? t(confirm.primary) : ''}
        onConfirm={() => {
          if (dialogs.confirmOpen && dialogs.confirm) runConfirm(dialogs.confirm);
        }}
      />
      <RenameDialog
        open={dialog?.kind === 'renameMeeting'}
        currentTitle={shown?.kind === 'renameMeeting' ? shown.meeting.title : ''}
        problem={rename.problem}
        busy={rename.busy}
        onSubmit={(newTitle) => {
          if (dialog?.kind === 'renameMeeting') void rename.rename(dialog.meeting.id, newTitle);
        }}
        onClose={closeDialog}
      />
    </section>
  );
}
