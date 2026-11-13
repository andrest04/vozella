import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  cliExecutableName,
  defaultMeetingTitle,
  findSummaryModel,
  RecordingPipeline,
  SummaryStage,
  type ApiKeyStore,
  type CliPathProbe,
  type Logger,
  type LocalModelStore,
  type OfflineTranscriber,
  type SettingsStore,
  type SummaryProviderResolver,
  type SummaryService,
  type TranslateFn,
  type Workspace,
  type CatalogLocale,
} from '@vozella/core';
import {
  directoryFor,
  liveRepository,
  repairWavFile,
  samePath,
  type LibraryRuntime,
} from '@vozella/platform';
import type { Broadcast } from '../ipc/library-handlers';
import type { AudioController } from '../audio/audio-controller';
import type { RecordingTakes } from '../audio/recording-take';
import type { TranscriptionController } from '../transcription/transcription-controller';
import { previousAudioKeeper } from './previous-audio';
import { RecordingService, type LiveAskHooks } from './recording-service';
import type { YouTubeAudioPort } from './youtube-import';

export interface ComposeRecordingDeps {
  readonly library: LibraryRuntime;
  readonly controller: AudioController;
  readonly takes: RecordingTakes;
  readonly transcription: TranscriptionController;
  readonly summaryService: SummaryService;
  readonly resolver: SummaryProviderResolver;
  readonly summaryModels: LocalModelStore;
  readonly cli: CliPathProbe;
  /** The app's API key store: an API engine that requires a key is ready only with one saved. */
  readonly apiKeys?: Pick<ApiKeyStore, 'has'>;
  readonly settings: SettingsStore;
  readonly workspace: Workspace;
  readonly broadcast: Broadcast;
  readonly logger: Logger;
  readonly translate: TranslateFn;
  readonly locale: () => CatalogLocale;
  readonly titleCatalog: (locale: CatalogLocale) => {
    MeetingTitleFormat: string;
    MeetingTitleDateFormat: string;
  };
  readonly formatFailure: (error: unknown) => string;
  readonly wavDurationSeconds: (file: string) => number;
  readonly youtube: YouTubeAudioPort;
  readonly liveAsk?: LiveAskHooks;
  readonly onRecordingStarted?: () => void;
}

/** The offline pass of the transcription module as the pipeline's port (188: repair first). */
function offlineTranscriber(transcription: TranscriptionController): OfflineTranscriber {
  return {
    isReady: async () => (await transcription.status()).ready,
    transcribe: (request) => {
      repairWavFile(request.audioPath);
      return transcription.transcribeFile({
        audioPath: request.audioPath,
        recordedAtMs: request.recordedAtMs,
        onProgress: request.onProgress,
        cancel: request.cancel,
      });
    },
  };
}

/** Builds the pipeline and the service from the pieces the composition root owns. */
export function composeRecording(deps: ComposeRecordingDeps): RecordingService {
  const { library } = deps;
  const summary = new SummaryStage({
    settings: deps.settings,
    resolver: deps.resolver,
    generator: deps.summaryService,
    translate: deps.translate,
  });
  const pipeline = new RecordingPipeline({
    meetings: liveRepository(() => library.meetings),
    settings: deps.settings,
    transcriber: offlineTranscriber(deps.transcription),
    formatFailure: deps.formatFailure,
    previousAudio: previousAudioKeeper(),
    summary,
  });
  const service = new RecordingService({
    onRecordingStarted: deps.onRecordingStarted,
    liveAsk: deps.liveAsk,
    takes: deps.takes,
    controller: deps.controller,
    library: {
      audioDirectory: async (folderId) =>
        directoryFor(library.libraryRoot, await library.folders.getAll(), folderId),
      folderExists: async (folderId) =>
        (await library.folders.getAll()).some((folder) => folder.id === folderId),
      ownsMarkdown: async (meetingId, markdownPath) =>
        (await library.meetings.locate(meetingId)).some((entry) =>
          samePath(entry.path, markdownPath),
        ),
    },
    files: {
      remove: (file) => {
        fs.rmSync(file, { force: true });
      },
      fileTimeMs: (file) => {
        try {
          return fs.statSync(file).mtimeMs;
        } catch {
          return null;
        }
      },
      wavDurationSeconds: deps.wavDurationSeconds,
      repair: (file) => {
        repairWavFile(file);
      },
    },
    settings: deps.settings,
    setup: {
      loadSettings: () => deps.settings.load(),
      localModelFileExists: (fileName) => {
        const model = findSummaryModel(fileName);
        return model === null ? Promise.resolve(false) : deps.summaryModels.isDownloaded(model);
      },
      cliOnPath: (kind) => deps.cli.isOnPath(cliExecutableName(kind)),
      apiKeySet: (kind) => deps.apiKeys?.has(kind) ?? Promise.resolve(false),
      engineReady: async () => (await deps.transcription.status()).ready,
    },
    pipeline,
    workspace: deps.workspace,
    live: { onUpdate: (listener) => deps.transcription.onLiveUpdate(listener) },
    broadcast: deps.broadcast,
    logger: deps.logger,
    nowMs: () => Date.now(),
    newId: () => randomUUID(),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    meetingTitle: async (meetingId) => (await library.meetings.get(meetingId))?.title ?? null,
    youtube: deps.youtube,
    defaultTitle: (atMs) => {
      const locale = deps.locale();
      return defaultMeetingTitle(new Date(atMs), locale, deps.titleCatalog(locale));
    },
  });
  // A summary can replace a placeholder title after the card is drawn.
  deps.workspace.on('meetingChanged', (id) => {
    void service.refreshLastTitle(id);
  });
  deps.workspace.on('meetingDeleted', (id) => {
    service.forgetMeeting(id);
  });
  return service;
}
