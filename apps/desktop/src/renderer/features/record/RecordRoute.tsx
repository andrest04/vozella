import {
  CLOUD_TRANSCRIPTION_ENGINES,
  defaultMeetingTitle,
  isCloudTranscriptionKind,
  type CloudLiveText,
} from '@vozella/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { FileUp, KeyRound, Link, Mic } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, SectionHeader, cn, useToast } from '../../ui';
import { useConnectedProjectDirectory } from '../meeting-list/project-directory';
import { SourcesPanel, type SourcesSelection } from '../audio/SourcesPanel';
import { openTranscriptionInSettings } from '../transcription/transcription-focus';
import { useEngineStatus } from '../transcription/use-engine-status';
import { AnswerCard } from './AnswerCard';
import { LiveAskDock } from './LiveAskDock';
import { LiveCanvas } from './LiveCanvas';
import { ProcessingBar, RetryAction } from './ProcessingBar';
import { needsCloudKey } from './needs-cloud-key';
import { NotepadPanel } from './notepad/NotepadPanel';
import { RecordIdle } from './RecordIdle';
import { buildDestinations, retainDestination } from './destinations';
import {
  arrangePanels,
  deriveRecordLayout,
  hasStatusError,
  withoutIdleRepeats,
  type StatusMessage,
} from './record-layout';
import { RecordingSession, useCanvasCopy } from './RecordingSession';
import { useRecordShortcuts, type RecordShortcutHandlers } from './use-record-shortcuts';
import { ResultCard } from './ResultCard';
import { SetupChecklist } from './SetupChecklist';
import { StatusBars, useStatusText } from './StatusBars';
import { useEnsureReady } from './use-ensure-ready';
import { YouTubeImportDialog } from './YouTubeImportDialog';
import {
  cancelBackgroundSummary,
  cancelProcessing,
  connectRecording,
  importFromYouTube,
  importRecording,
  retryProcessing,
  setNotice,
  setProjectId,
  setTitle,
  startRecording,
  useRecordingStore,
} from './use-recording';
import { useLiveAskStore } from './use-live-ask';
import { useTakeNotesRequest } from './use-take-notes';

/** What the empty live canvas says with a cloud engine, by how its live text arrives. */
const LIVE_HINT_KEYS: Readonly<Record<CloudLiveText, StringKey>> = {
  pieces: 'Ui_LiveCloudHint',
  streaming: 'Ui_LiveStreamingHint',
};

const NO_SELECTION: SourcesSelection = {
  microphone: null,
  processId: null,
  appName: null,
  summary: '',
};

const useWindowWidth = (): number => {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => {
      setWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return width;
};

/** Opens the saved meeting in the Session page on the Summary tab if it has one (spec 2.13). */
async function openMeeting(id: string): Promise<void> {
  try {
    const { record } = await window.vozella.invoke('library.getMeeting', { id });
    const tab = record?.summary != null ? 'Summary' : 'Transcript';
    await window.vozella.invoke('workspace.dispatch', { action: { type: 'selectMeeting', id } });
    await window.vozella.invoke('workspace.dispatch', { action: { type: 'openSession', tab } });
  } catch {
    // The card stays; the user can open the meeting from the library.
  }
}

/**
 * The Record page: a thin container over the recording store. The idle zone (title, destination,
 * sources, setup panel), the action row, the result card and the status bars are drawn here from main's
 * state; the recording bar and the processing bar are the next packages' work and keep the
 * controls the page already had.
 */
export function RecordRoute() {
  const { t, locale } = useI18n();
  const store = useRecordingStore();
  const { state, setup, busy } = store;
  const [selection, setSelection] = useState<SourcesSelection>(NO_SELECTION);
  const [youTubeOpen, setYouTubeOpen] = useState(false);
  const { status: engine } = useEngineStatus();
  const { ensureReady, dialogs } = useEnsureReady();
  const directory = useConnectedProjectDirectory();
  const toast = useToast();
  const answer = useLiveAskStore((s) => s.answer);
  const width = useWindowWidth();

  useEffect(() => connectRecording(), []);

  const phase = state?.phase ?? 'Idle';
  const active = phase !== 'Idle';
  const isRecording = state?.isRecording ?? false;
  const isProcessing = (state?.isProcessing ?? false) || (active && !isRecording);
  const idle = !active && busy === null;
  const savedMeeting =
    !active && state?.lastMeeting && state.lastMeeting.id !== store.clearedMeetingId
      ? state.lastMeeting
      : null;

  // After the hand-off the summary runs on its own; main's status says so (B-21).
  const summarizing =
    !active && (state?.status ?? []).some((message) => message.key === 'Status_GeneratingSummary');

  const flags = deriveRecordLayout({
    isRecording,
    isProcessing,
    isReadyToRecord: setup?.canRecord ?? true,
    hasCanvasTranscript: store.liveText !== '',
  });

  const defaultTitle = useMemo(
    () =>
      defaultMeetingTitle(new Date(store.defaultAtMs), locale, {
        MeetingTitleFormat: t('MeetingTitleFormat'),
        MeetingTitleDateFormat: t('MeetingTitleDateFormat'),
      }),
    [store.defaultAtMs, locale, t],
  );
  const title = isRecording ? (state?.title ?? '') : (store.title ?? defaultTitle);

  const record = useCallback(async (): Promise<void> => {
    if (!(await ensureReady())) return;
    await startRecording({ title, ...selection });
  }, [ensureReady, title, selection]);

  const importAudio = async (): Promise<void> => {
    if (!(await ensureReady())) return;
    await importRecording(title);
  };

  const importYouTube = async (url: string): Promise<void> => {
    if (!(await ensureReady())) return;
    await importFromYouTube(title, url);
  };

  // Ctrl+R starts a take from the idle page (2.5); once recording, the session binds it to Stop.
  const idleShortcuts = useMemo<RecordShortcutHandlers | null>(
    () =>
      active
        ? null
        : {
            stop: { enabled: idle && flags.showRecordHero, run: () => void record() },
            pause: { enabled: false, run: () => undefined },
            discard: { enabled: false, run: () => undefined },
          },
    [active, idle, flags.showRecordHero, record],
  );
  useRecordShortcuts(idleShortcuts);

  useTakeNotesRequest(idle, () => {
    void record();
  });

  // The chosen project is kept while it exists and falls back to No project once it is gone.
  useEffect(() => {
    if (directory.status !== 'ready' || directory.storage.status !== 'ready') return;
    const kept = retainDestination(
      store.projectId,
      buildDestinations(directory.projects, '', locale),
    );
    if (kept !== store.projectId && !isRecording) setProjectId(kept);
  }, [
    directory.status,
    directory.storage.status,
    directory.projects,
    store.projectId,
    isRecording,
    locale,
  ]);

  // The status the page shows: main's list while a take or a run exists, else the idle line.
  const messages: readonly StatusMessage[] = useMemo(() => {
    const fromMain = state?.status ?? [];
    if (fromMain.length > 0) return fromMain;
    if (store.notice) return [store.notice];
    if (!active && setup) return [{ ...setup.idleStatus, severity: 'info' as const }];
    return [];
  }, [state?.status, store.notice, active, setup]);
  const statusText = useStatusText(messages);
  const canvasCopy = useCanvasCopy(store.liveText);
  const destination = useMemo(() => {
    const noProject = t('Ui_ProjectNone');
    return (
      buildDestinations(directory.projects, noProject, locale).find(
        (d) => d.projectId === store.projectId,
      )?.label ?? noProject
    );
  }, [directory.projects, store.projectId, locale, t]);

  // Start meeting in this project arrives as /record?project=<id>&start=1. The parameters are read
  // once and the address is replaced before anything async runs, so a refresh never starts again.
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const consumed = useRef(false);
  const [launch, setLaunch] = useState<{ project: string | null; start: boolean } | null>(null);
  useEffect(() => {
    const asked = search.project !== undefined || search.start !== undefined;
    if (!asked) {
      consumed.current = false;
      return;
    }
    if (consumed.current) return;
    consumed.current = true;
    void navigate({ to: '/record', search: {}, replace: true });
    setLaunch({ project: search.project ?? null, start: search.start === 1 });
  }, [search.project, search.start, navigate]);

  const sourcesReady = selection.microphone !== null;
  useEffect(() => {
    if (launch === null || state === null || directory.status === 'loading') return;
    // Another take is under way: it keeps its destination and no second one begins.
    if (active) {
      setLaunch(null);
      toast.show({
        title: t('Ui_RecordAlreadyRecording'),
        description: t('Ui_RecordSavingTo', destination),
      });
      return;
    }
    const known =
      directory.storage.status === 'ready' &&
      launch.project !== null &&
      directory.projects.some((project) => project.id === launch.project);
    if (launch.project !== null && !known) {
      setLaunch(null);
      setProjectId(null);
      setNotice({
        key:
          directory.storage.status === 'ready'
            ? 'Ui_RecordProjectGone'
            : 'Ui_ProjectsUnavailableNow',
        args: [],
        severity: 'info',
      });
      return;
    }
    setProjectId(launch.project);
    if (!launch.start) {
      setLaunch(null);
      return;
    }
    // The take starts once the sources have loaded, so it records from the default microphone.
    if (!sourcesReady || !idle) return;
    setLaunch(null);
    void record();
  }, [
    launch,
    state,
    active,
    idle,
    sourcesReady,
    directory.status,
    directory.storage.status,
    directory.projects,
    destination,
    record,
    toast,
    t,
  ]);
  const cloudEngine =
    engine !== null && isCloudTranscriptionKind(engine.engine) ? engine.engine : null;
  // How the captions of a cloud engine arrive is a column of the engine table: in pieces they are
  // a few seconds behind, streamed they follow the speech. Either way, when its live pass covers
  // the take, that text is the saved transcript, not only a preview.
  const emptyText =
    engine && !engine.liveEnabled
      ? t('Ui_LiveSkipped')
      : cloudEngine
        ? t(LIVE_HINT_KEYS[CLOUD_TRANSCRIPTION_ENGINES[cloudEngine].liveText])
        : t('RecordPage_LiveTranscriptHint.Text');
  // The transcription engine is a cloud one without its key: the step is the key, in Settings.
  const addCloudKey = setup !== null && needsCloudKey(setup);
  const captionText = hasStatusError(messages) ? '' : statusText;
  const panels = arrangePanels(width);
  const scrollSession = flags.isSessionActive;

  return (
    <section
      className={
        scrollSession
          ? 'flex flex-col gap-6'
          : // Before a take the page is a document across the shell's page column. The scroll
            // margin keeps a control that takes focus clear of the sticky action row.
            'flex w-full flex-col gap-8 [&_*]:scroll-mb-28'
      }
      data-testid="record-page"
      data-session={scrollSession ? 'true' : 'false'}
    >
      {active ? (
        <SectionHeader
          level={1}
          title={t('RecordPage_Title.Text')}
          description={isRecording ? undefined : t('RecordPage_Subtitle.Text')}
        />
      ) : (
        <h1 className="sr-only">{t('RecordPage_Title.Text')}</h1>
      )}

      <RecordIdle
        hidden={isRecording}
        asDocument={!active}
        title={title}
        onTitleChange={setTitle}
        titleDisabled={isRecording || busy === 'starting'}
        projects={directory.projects}
        projectId={store.projectId}
        onProjectChange={setProjectId}
        destinationDisabled={isRecording || busy === 'starting'}
      >
        <SourcesPanel
          active={idle}
          locked={!idle}
          quiet={!active}
          onSelectionChange={setSelection}
        />

        {flags.showSetupPanel && setup ? <SetupChecklist setup={setup} /> : null}
      </RecordIdle>

      {isRecording && state ? (
        <>
          <StatusBars messages={messages} scope="session" />
          <RecordingSession
            state={state}
            liveText={store.liveText}
            committedText={store.committedText}
            destination={destination}
            sources={selection.summary}
            statusText={captionText}
            emptyText={emptyText}
            side={
              <div className="flex min-w-0 flex-col gap-4">
                <AnswerCard answer={answer} />
                <NotepadPanel maxHeight={panels.notesMaxHeight} />
              </div>
            }
            dock={<LiveAskDock enabled={state.phase === 'Recording'} />}
            sideBySide={panels.sideBySide}
          />
        </>
      ) : active ? (
        <div
          className={
            panels.sideBySide
              ? 'grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4'
              : 'flex flex-col gap-4'
          }
          data-testid="record-session"
        >
          <div className="flex min-w-0 flex-col gap-4">
            <ProcessingBar
              statusText={statusText}
              canCancel={(state?.isProcessing ?? false) || busy === 'importing'}
              onCancel={() => void cancelProcessing()}
            />
            <StatusBars messages={messages} scope="session" />
            {flags.showTranscriptCanvas ? (
              <LiveCanvas
                heading={t(flags.canvasHeadingKey)}
                live={false}
                text={store.liveText}
                committedLines={Number.POSITIVE_INFINITY}
                emptyText={emptyText}
                highlightFeedback={null}
                statusText={null}
                copied={canvasCopy.copied}
                onCopy={null}
                className="h-96"
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <AnswerCard answer={answer} />
            <NotepadPanel />
          </div>
        </div>
      ) : null}

      {savedMeeting ? (
        <ResultCard
          title={savedMeeting.title}
          onOpen={() => {
            void openMeeting(savedMeeting.id);
          }}
          onCancelSummary={
            summarizing
              ? () => {
                  void cancelBackgroundSummary(savedMeeting.id);
                }
              : null
          }
        />
      ) : null}

      {!active && flags.showTranscriptCanvas ? (
        <LiveCanvas
          heading={t(flags.canvasHeadingKey)}
          live={false}
          text={store.liveText}
          committedLines={Number.POSITIVE_INFINITY}
          emptyText={emptyText}
          highlightFeedback={null}
          statusText={null}
          copied={canvasCopy.copied}
          onCopy={canvasCopy.copy}
          surfaceTestId="saved-transcript"
          className="h-96"
        />
      ) : null}

      {!active ? (
        // Last in the page and sticky, so the next step stays in view however long the page gets. The
        // offset cancels the scroll container's bottom padding: nothing shows under the row. The
        // status caption is centered for the old hero; here it lines up with the buttons under it.
        <div
          className={cn(
            'sticky -bottom-8 z-10 flex flex-col gap-3 border-t border-hairline bg-paper py-3',
            '[&_[data-testid=status-text]]:mx-0 [&_[data-testid=status-text]]:text-left',
            flags.showSetupPanel && '-mt-6',
          )}
          data-testid="record-actions"
        >
          {busy === 'starting' ? (
            <p role="status" className="text-ui text-ink-muted">
              {t('Ui_TakeStarting')}
            </p>
          ) : null}
          <StatusBars messages={withoutIdleRepeats(messages, flags.showSetupPanel)} scope="idle" />
          {state?.canRetry ? (
            <RetryAction
              onRetry={() => {
                void retryProcessing();
              }}
            />
          ) : null}
          {flags.showSetupPanel && setup ? (
            <div>
              {addCloudKey ? (
                // Nothing to install: one step, straight to the key field in Settings.
                <Button
                  variant="primary"
                  icon={KeyRound}
                  disabled={busy !== null}
                  onClick={() => {
                    openTranscriptionInSettings('key');
                  }}
                  data-testid="BtnAddApiKey"
                >
                  {t('Ui_SetupAddKey')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => {
                    void ensureReady();
                  }}
                  data-testid="BtnSetUpToRecord"
                >
                  {t('RecordingSetup_SetUpToRecord.Content')}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex flex-wrap items-center gap-3" data-testid="record-hero">
                <Button
                  variant="primary"
                  icon={Mic}
                  disabled={busy !== null}
                  data-testid="BtnRecord"
                  onClick={() => void record()}
                >
                  {t('Record_Record')}
                </Button>
                {flags.showImportAudio ? (
                  <Button
                    icon={FileUp}
                    disabled={busy !== null}
                    data-testid="BtnImportAudio"
                    onClick={() => void importAudio()}
                  >
                    {t('Record_Import')}
                  </Button>
                ) : null}
                {flags.showImportAudio ? (
                  <Button
                    icon={Link}
                    disabled={busy !== null}
                    data-testid="BtnImportYouTube"
                    onClick={() => {
                      setYouTubeOpen(true);
                    }}
                  >
                    {t('Ui_ImportYouTube')}
                  </Button>
                ) : null}
              </div>
              <p className="text-ui text-ink-muted">{t('Ui_RecordHelper')}</p>
            </div>
          )}
        </div>
      ) : null}

      <YouTubeImportDialog
        open={youTubeOpen}
        onOpenChange={setYouTubeOpen}
        onImport={(url) => void importYouTube(url)}
      />
      {dialogs}
    </section>
  );
}
