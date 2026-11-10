import { resolveAccentKey, resolveIconKey } from '@vozella/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, ConfirmDialog, EmptyState, Notice, Skeleton, cn } from '../../ui';
import { Breadcrumbs } from './Breadcrumbs';
import { BulkBar } from './BulkBar';
import { matchLibraryShortcut } from '../../app/shortcuts';
import { RenameDialog } from '../session/RenameDialog';
import { MoveDialog, NameDialog, PersonalityDialog } from './dialogs';
import {
  refreshLibrary,
  rememberScroll,
  setCursor,
  setFilters,
  useLibraryStore,
} from './library-store';
import { folderIdOfView } from './library-store';
import { folderMenuEntries } from './LibraryFolders';
import { ListHeader } from './ListHeader';
import { MeetingGrid } from './MeetingGrid';
import { FilterButton, FilterChips } from './MeetingFilterControls';
import { NO_FILTERS, filterKey, isFiltering, type MeetingFilters } from './meeting-filters';
import { MeetingPreview } from './MeetingPreview';
import { describeSkipped } from './format';
import { HEADER_ROW_PX, MEETING_ROW_PX, nextCursor } from './logbook';
import { tabOfHit } from './search-results';
import { UndoOffer } from './UndoOffer';
import { useBulkActions } from './use-bulk-actions';
import {
  confirmText,
  useLibraryDialogs,
  useMeetingRename,
  type ConfirmDialogState,
} from './use-library-dialogs';
import { useListFocus } from './use-list-focus';
import { useMeetingPreview } from './use-meeting-preview';
import { useLibrary, type StatusMessage } from './use-library';

/** From this width of the content the preview sits beside the list; below it a click opens. */
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

/** The Library route: the list pane with its header, the preview pane and the dialogs. */
export function LibraryRoute() {
  const { t, locale } = useI18n();
  const library = useLibrary(locale, t('Library_Inbox'));
  const { ref: layoutRef, wide } = useWideLayout();
  const [startupError, setStartupError] = useState<string | null>(null);
  const [skippedDismissed, setSkippedDismissed] = useState(false);

  useEffect(() => {
    void window.vozella.invoke('library.getLocation', {}).then((location) => {
      setStartupError(location.startupError);
    });
  }, []);

  const text = (message: StatusMessage): string => t(message.key, ...message.args);
  const folderName = (id: string): string => library.folders.find((f) => f.id === id)?.name ?? '';

  const crumbs = library.breadcrumbs.map((crumb) => ({
    id: crumb.folderId,
    label: crumb.folderId === null ? t('Library_Inbox') : folderName(crumb.folderId),
  }));

  const dialogs = useLibraryDialogs({
    folderName,
    canDeleteFolder: library.canDeleteFolder,
    showStatus: library.showStatus,
  });
  const { dialog, shown, openDialog, closeDialog, runFolderAction } = dialogs;
  const dialogChrome = {
    cancelLabel: '',
    closeLabel: t('Ui_Close'),
    onOpenChange: (open: boolean): void => {
      if (!open) closeDialog();
    },
  };
  const personalityFolder =
    shown?.kind === 'personality'
      ? (library.folders.find((f) => f.id === shown.folderId) ?? null)
      : null;
  const newFolderTitle =
    library.selectedFolder === null
      ? t('LibraryNewFolder_Title')
      : t('LibraryNewFolder_TitleIn', library.selectedFolder.name);

  const cursorId = useLibraryStore((state) => state.cursorId);
  const listedIds = useMemo(() => library.meetings.map((m) => m.id), [library.meetings]);
  const lastListed = useRef<readonly string[]>([]);
  // The preview needs a row: the newest at first, the neighbor when the row went away.
  useEffect(() => {
    const previous = lastListed.current;
    lastListed.current = listedIds;
    // `wide` starts true, and a list already loaded gets here before that measure takes effect.
    const width = layoutRef.current?.clientWidth ?? PANED_LAYOUT_PX;
    if (!wide || width < PANED_LAYOUT_PX || library.isLoading) return;
    const next = nextCursor(useLibraryStore.getState().cursorId, previous, listedIds);
    if (next !== useLibraryStore.getState().cursorId) setCursor(next);
  }, [listedIds, wide, library.isLoading, cursorId, layoutRef]);
  const viewKey = `${library.view.kind}-${String(folderIdOfView(library.view))}`;
  const filters = useLibraryStore((state) => state.filters);
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
    library,
    listedIds,
    t,
    listKey: `${viewKey}|${library.query}|${filtersKey}`,
    openDialog,
    afterWork,
  });
  const { checks, bulkWork, undoMove } = bulk;

  const rename = useMeetingRename({
    t,
    refresh: refreshLibrary,
    onRenamed: () => {
      closeDialog();
      afterWork();
    },
  });

  const onRowKey = (
    action: 'toggle' | 'rename' | 'delete' | 'deletePermanently' | 'clear',
    id: string,
  ): void => {
    const meeting = library.meetings.find((m) => m.id === id);
    if (action === 'clear') {
      if (checks.checked.size > 0) bulk.clearChecks();
      else library.setQuery('');
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

  /** What yes does in each confirmation. */
  const runConfirm = (confirmed: ConfirmDialogState): void => {
    switch (confirmed.kind) {
      case 'deleteFolder':
        void library.deleteFolder(confirmed.folderId);
        return;
      case 'deleteMany':
        void bulk.runDeleteMany(confirmed.meetingIds, 'trash');
        return;
      case 'deleteManyPermanently':
        void bulk.runDeleteMany(confirmed.meetingIds, 'permanent');
        return;
      case 'deleteMeeting': {
        const { meeting } = confirmed;
        void library.deleteMeeting(meeting.id).then((outcome) => {
          if (outcome === 'trash-failed') {
            openDialog({ kind: 'deleteMeetingPermanently', meeting, refused: true });
          }
          afterWork();
        });
        return;
      }
      case 'deleteMeetingPermanently':
        void library.deleteMeeting(confirmed.meeting.id, 'permanent').then(afterWork);
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

  const gridLabels = useMemo(
    () => ({
      grid: t('HistoryPage_Title.Text'),
      noContent: t('History_NoContent'),
      more: t('HistoryRow_More.AutomationProperties.Name'),
      openSummary: t('HistoryRow_OpenSummary'),
      move: t('HistoryRow_Move'),
      remove: t('HistoryRow_Delete'),
      today: t('Ui_LibraryToday'),
      yesterday: t('Ui_LibraryYesterday'),
      noDate: t('Ui_LibraryNoDate'),
      duration: (minutes: number) => t('Ui_LibraryDurationMinutes', String(minutes)),
      checkMeeting: (title: string) => t('Ui_LibraryCheckMeeting', title),
      checkDay: (day: string) => t('Ui_LibraryCheckDay', day),
      dragCount: (count: number) => t('Ui_LibraryDragCount', String(count)),
    }),
    [t],
  );

  const { flags } = library;
  // Nothing matched is not known yet while the second stage is still reading.
  const emptyMessage: StringKey | null = flags.showLibraryEmpty
    ? 'HistoryPage_Empty.Text'
    : flags.showInboxEmpty
      ? 'Library_InboxEmpty.Text'
      : flags.showFolderEmpty
        ? 'Library_FolderEmpty.Text'
        : library.filtersHideAll
          ? 'Ui_LibraryFilterEmpty'
          : flags.showNoMatches && !library.searching
            ? 'Ui_LibrarySearchEmpty'
            : null;
  const searchStatus = library.searching
    ? t('Ui_LibrarySearching')
    : library.searchFailed
      ? t('Ui_LibrarySearchTitlesOnly')
      : t('Ui_LibrarySearchMatches', String(library.meetings.length));

  return (
    <section ref={layoutRef} className="flex min-h-0 flex-1">
      <div
        data-testid="library-list-pane"
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          wide ? 'w-[clamp(340px,38%,440px)] shrink-0 border-e border-hairline' : 'flex-1',
        )}
      >
        <ListHeader
          title={
            library.selectedFolder
              ? library.selectedFolder.name
              : library.view.kind === 'all'
                ? t('Ui_LibraryAll')
                : t('Library_Inbox')
          }
          count={library.viewCount}
          countText={
            filtering
              ? t(
                  'Ui_LibraryFilteredCount',
                  String(library.meetings.length),
                  String(library.viewCount),
                )
              : String(library.viewCount)
          }
          filterButton={
            <FilterButton filters={filters} onChange={setFilters} buttonRef={filterButtonRef} />
          }
          filterChips={
            <FilterChips
              filters={filters}
              onChange={changeFiltersFromList}
              showClear={!library.filtersHideAll}
            />
          }
          filterResults={
            filtering
              ? t(
                  'Ui_LibraryFilterResultsLine',
                  String(library.meetings.length),
                  String(library.viewCount),
                )
              : ''
          }
          filterResultsLabel={t('Ui_LibraryFilterResults')}
          folder={library.selectedFolder}
          breadcrumbs={
            <Breadcrumbs
              crumbs={crumbs}
              label={t('Chat_ScopeFolder')}
              onSelect={library.selectFolder}
            />
          }
          menuEntries={
            library.selectedFolder
              ? folderMenuEntries(t, library.selectedFolder.id, runFolderAction)
              : []
          }
          menuLabel={t('Ui_LibraryFolderActions')}
          note={library.noteText}
          noteLabel={t('Library_FolderNote.Header')}
          notePlaceholder={t('Library_FolderNote.PlaceholderText')}
          onNoteChange={library.setNoteText}
          onNoteBlur={() => {
            void library.saveNote();
          }}
          query={library.query}
          searchLabel={t('Library_Search.PlaceholderText')}
          searchRef={searchRef}
          onSearchKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              library.setQuery('');
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              gridRef.current?.focusCursor();
            }
          }}
          clearSearchLabel={t('Ui_LibrarySearchClear')}
          onQueryChange={library.setQuery}
          searchStatus={searchStatus}
          searchAll={
            library.view.kind === 'all'
              ? null
              : { label: t('Ui_LibrarySearchAll'), onSelect: library.searchEverything }
          }
        />

        <div className="flex shrink-0 flex-col gap-2 px-4 empty:hidden">
          {startupError ? (
            <Notice tone="warning">{t('Ui_LibraryMigrationFailed', startupError)}</Notice>
          ) : null}
          {library.problem ? (
            <Notice tone="warning">
              {library.problem.reason === 'corrupt'
                ? t('Ui_LibraryFoldersDamaged', library.problem.message ?? '')
                : t('Ui_LibraryFolderFailed', library.problem.message ?? library.problem.reason)}
            </Notice>
          ) : null}
          {library.skipped.length > 0 && !skippedDismissed ? (
            <Notice
              onDismiss={() => {
                setSkippedDismissed(true);
              }}
              dismissLabel={t('Ui_Close')}
            >
              {t('Ui_LibrarySkippedFiles', describeSkipped(library.skipped))}
            </Notice>
          ) : null}
          {library.status ? (
            <Notice tone="warning" onDismiss={library.dismissStatus} dismissLabel={t('Ui_Close')}>
              {text(library.status)}
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
            moveLabel={t('HistoryRow_Move')}
            deleteLabel={t('HistoryRow_Delete')}
            clearLabel={t('Ui_LibraryBulkClear')}
            onMove={() => {
              bulk.askMove(bulk.checkedMeetings);
            }}
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
          {library.isLoading ? (
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
          ) : library.flags.hasMeetings ? (
            <MeetingGrid
              handle={gridRef}
              key={`${viewKey}-${filtersKey}`}
              meetings={library.meetings}
              locale={locale}
              labels={gridLabels}
              query={library.query}
              hits={library.hits}
              cursorId={cursorId}
              clickOpens={!wide}
              initialScrollOffset={useLibraryStore.getState().scrollOffset}
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
                library.openMeeting(id, tabOfHit(library.hits.get(id)) ?? 'Transcript');
              }}
              onOpenSummary={(id) => {
                library.openMeeting(id, 'Summary');
              }}
              onMove={(meeting) => {
                setFromKeyboard(false);
                bulk.askMove(bulk.targetsOf(meeting));
              }}
              onDelete={(meeting) => {
                setFromKeyboard(false);
                bulk.askDelete(bulk.targetsOf(meeting), false);
              }}
              onRowKey={onRowKey}
              onSelectAll={bulk.selectAll}
            />
          ) : emptyMessage ? (
            <div className="px-4">
              <EmptyState
                message={t(emptyMessage)}
                action={
                  flags.showLibraryEmpty ? (
                    <Button onClick={library.goRecord}>{t('HistoryPage_EmptyCta.Content')}</Button>
                  ) : emptyMessage === 'Ui_LibraryFilterEmpty' ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        changeFiltersFromList(NO_FILTERS);
                      }}
                    >
                      {t('Ui_LibraryFilterClear')}
                    </Button>
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
            preferredTab={previewId === null ? null : tabOfHit(library.hits.get(previewId))}
            onOpen={library.openMeeting}
          />
        </section>
      ) : null}

      <NameDialog
        {...dialogChrome}
        open={dialog?.kind === 'newFolder'}
        title={newFolderTitle}
        cancelLabel={t('LibraryNewFolder_Cancel')}
        primaryLabel={t('LibraryNewFolder_Primary')}
        fieldLabel={t('LibraryFolderName.Header')}
        placeholder={t('LibraryFolderName.PlaceholderText')}
        initialValue=""
        onSubmit={async (name) => {
          const result = await library.createFolder(name);
          return !result.ok && result.reason === 'name-taken' ? t('Ui_LibraryNameTaken') : null;
        }}
      />
      <NameDialog
        {...dialogChrome}
        open={dialog?.kind === 'rename'}
        title={t('LibraryRenameFolder_Title')}
        cancelLabel={t('LibraryRenameFolder_Cancel')}
        primaryLabel={t('LibraryRenameFolder_Primary')}
        fieldLabel={t('LibraryFolderName.Header')}
        placeholder={t('LibraryFolderName.PlaceholderText')}
        initialValue={shown?.kind === 'rename' ? shown.name : ''}
        onSubmit={async (name) => {
          if (dialog?.kind !== 'rename') return null;
          const result = await library.renameFolder(dialog.folderId, name);
          return !result.ok && result.reason === 'name-taken' ? t('Ui_LibraryNameTaken') : null;
        }}
      />
      <PersonalityDialog
        {...dialogChrome}
        open={dialog?.kind === 'personality'}
        title={t('LibraryPersonality_Title')}
        cancelLabel={t('LibraryPersonality_Cancel')}
        primaryLabel={t('LibraryPersonality_Primary')}
        folderName={personalityFolder?.name ?? ''}
        colorHeader={t('LibraryPersonality_ColorHeader.Text')}
        iconHeader={t('LibraryPersonality_IconHeader.Text')}
        initialColor={resolveAccentKey(personalityFolder?.colorKey, personalityFolder?.id ?? '')}
        initialIcon={resolveIconKey(personalityFolder?.iconKey)}
        onSave={(colorKey, iconKey) => {
          if (dialog?.kind === 'personality') {
            void library.updatePersonality(dialog.folderId, colorKey, iconKey);
          }
        }}
      />
      <MoveDialog
        {...dialogChrome}
        open={dialog?.kind === 'move'}
        title={t('LibraryMove_Title')}
        cancelLabel={t('LibraryMove_Cancel')}
        primaryLabel={t('LibraryMove_Primary')}
        destinations={library.destinations}
        currentFolderId={shown?.kind === 'move' ? shown.meeting.folderId : null}
        onMove={(folderId) => {
          if (dialog?.kind !== 'move') return;
          const { meeting } = dialog;
          void library.moveMeeting(meeting.id, folderId).then((moved) => {
            if (moved && meeting.folderId !== folderId) bulk.offerUndo([meeting], folderId);
          });
        }}
      />
      <MoveDialog
        {...dialogChrome}
        open={dialog?.kind === 'moveMany'}
        title={t(
          'Ui_LibraryMoveManyTitle',
          String(shown?.kind === 'moveMany' ? shown.meetings.length : 0),
        )}
        cancelLabel={t('LibraryMove_Cancel')}
        primaryLabel={t('LibraryMove_Primary')}
        destinations={library.destinations}
        currentFolderId={null}
        onMove={(folderId) => {
          if (dialog?.kind === 'moveMany') void bulk.runMoveMany(dialog.meetings, folderId);
        }}
      />
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
        onSubmit={(title) => {
          if (dialog?.kind === 'renameMeeting') void rename.rename(dialog.meeting.id, title);
        }}
        onClose={closeDialog}
      />
    </section>
  );
}
