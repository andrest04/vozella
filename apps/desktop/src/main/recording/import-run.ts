import type { RecordingMessageDto } from '@vozella/contracts';
import {
  CancelSource,
  evaluateSetup,
  importTimes,
  parseYouTubeUrl,
  type CancelSignal,
  type Logger,
  type Message,
  type PipelineRequest,
  type RecordingSessionGate,
  type RecordingSetupPorts,
} from '@vozella/core';
import { allocateAudioPath } from './audio-path';
import { describeError, typed } from './recording-message';
import { youTubeFailure, type YouTubeAudioPort } from './youtube-import';

export interface ImportConversionDeps {
  /** Converts any supported file to 16 kHz mono PCM16 WAV (multi-channel is downmixed, B-5). */
  convert(source: string, destination: string): Promise<void>;
  /** Stops a conversion in progress. */
  cancelConversion(): void;
  /** The dated WAV path in the destination folder. */
  allocate(title: string, atMs: number): string | Promise<string>;
  wavDurationSeconds(file: string): number;
  remove(file: string): void;
  nowMs(): number;
}

export type ImportConversion =
  | {
      readonly ok: true;
      readonly path: string;
      readonly recordedAtMs: number;
      readonly endedAtMs: number;
    }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: Message };

/**
 * Spec 2.12 step 5 and 6. Converts the file, reads the duration and derives the times (B-19).
 * A failure or a cancel removes the partial WAV; only an error carries a message to show.
 */
export async function convertForImport(
  deps: ImportConversionDeps,
  request: { source: string; title: string; fileTimeMs: number | null },
  cancel: CancelSignal,
): Promise<ImportConversion> {
  let destination: string | null = null;
  const removePartial = (): void => {
    if (destination === null) return;
    try {
      deps.remove(destination);
    } catch {
      // A partial file we cannot delete is left for the user; the failure is already reported.
    }
  };
  const stopListening = cancel.onCancel(() => {
    deps.cancelConversion();
  });
  try {
    // The stem carries the date of the file; the real start is known once the length is read.
    destination = await deps.allocate(request.title, request.fileTimeMs ?? deps.nowMs());
    await deps.convert(request.source, destination);
    if (cancel.cancelled) {
      removePartial();
      return cancelled();
    }
    const durationMs = Math.round(deps.wavDurationSeconds(destination) * 1000);
    const times = importTimes(request.fileTimeMs, durationMs, deps.nowMs());
    return { ok: true, path: destination, ...times };
  } catch (error) {
    removePartial();
    if (cancel.cancelled) return cancelled();
    const text = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      cancelled: false,
      message: { key: 'Error_ImportAudio', args: [text] },
    };
  } finally {
    stopListening();
  }
}

function cancelled(): ImportConversion {
  return { ok: false, cancelled: true, message: { key: 'Status_ProcessingCancelled', args: [] } };
}

// -- the import run (2.12) ------------------------------------------------------------------------

export interface ImportRequest {
  readonly title: string;
  readonly folderId: string | null;
  readonly path: string;
}

export interface ImportUrlRequest {
  readonly title: string;
  readonly folderId: string | null;
  readonly url: string;
}

export interface ImportOptions {
  /** A meeting the import re-records (the session views pass it). */
  readonly meetingId?: string | null;
}

export type ImportResult =
  | { readonly started: true; readonly meetingId: string }
  | {
      readonly started: false;
      readonly reason: 'busy' | 'not-ready' | 'failed' | 'cancelled';
      readonly message: RecordingMessageDto | null;
    };

/** The file an import converts, or why there is none (a failed or cancelled download). */
type PreparedImport =
  | { readonly ok: true; readonly path: string; readonly fileTimeMs: number | null }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: Message };

/** Where an import's audio comes from: a picked file or a YouTube download. */
interface ImportSource {
  /** The status shown from the start of the import until the conversion begins. */
  readonly status: Message;
  prepare(meetingId: string, cancel: CancelSignal): Promise<PreparedImport>;
  /** Runs once the import is over, whatever the outcome, when `prepare` was called. */
  release?(meetingId: string): void;
}

const IMPORTING_STATUS: Message = { key: 'Status_Importing', args: [] };

/**
 * What an import borrows from the owner of the take (RecordingService): the take state an import
 * resets like a start does, the idle meter, the published state and the pipeline run.
 */
export interface ImportHost {
  /** A fresh take: run state, notes, retry and source notice reset; returns the title in use. */
  beginTake(meetingId: string | null, requestedTitle: string): string;
  /** The idle meter stops for the length of the import (173). */
  holdPreview(): void;
  restorePreview(): void;
  publish(): void;
  /** Marks the import as protected work for a close (101); returns the call that settles it. */
  trackPreparing(): () => void;
  /** Files the converted WAV in its folder and starts the processing run on it. */
  process(request: Omit<PipelineRequest, 'folderId'>, folderId: string | null): Promise<void>;
}

export interface ImportRunDeps {
  /** The session gate of the service itself: one take at a time, live or imported. */
  readonly gate: Pick<RecordingSessionGate, 'tryBeginPreparing' | 'cancelPreparing'>;
  readonly setTakeStatus: (message: Message) => void;
  readonly host: ImportHost;
  readonly setup: RecordingSetupPorts;
  readonly controller: {
    importAudio(source: string, destination: string): Promise<void>;
    cancelImport(): void;
  };
  readonly library: {
    audioDirectory(folderId: string | null): Promise<string>;
    ownsMarkdown(meetingId: string, markdownPath: string): Promise<boolean>;
  };
  readonly files: {
    remove(file: string): void;
    fileTimeMs(file: string): number | null;
    wavDurationSeconds(file: string): number;
  };
  /** yt-dlp and the temp folder for the import from a YouTube link. */
  readonly youtube: YouTubeAudioPort;
  readonly logger: Logger;
  readonly nowMs: () => number;
  readonly newId: () => string;
}

/**
 * The file and YouTube imports (spec 2.12). They change apart from the live capture, so they live
 * here; the session gate stays the one of the service, so an import and a take never overlap.
 */
export class ImportRun {
  private cancelSource: CancelSource | null = null;

  constructor(private readonly deps: ImportRunDeps) {}

  /** The processing bar's Cancel while an import runs. False when no import runs. */
  cancel(): boolean {
    if (this.cancelSource === null) return false;
    this.cancelSource.cancel();
    return true;
  }

  /**
   * Imports an audio file through the same pipeline as a take: same gate and readiness checks, the
   * file converted to the take WAV, then a request with no live draft, pause or highlights (172).
   */
  importAudio(request: ImportRequest, options: ImportOptions = {}): Promise<ImportResult> {
    const { files } = this.deps;
    return this.run(request, options, {
      status: IMPORTING_STATUS,
      prepare: () =>
        Promise.resolve({
          ok: true,
          path: request.path,
          fileTimeMs: files.fileTimeMs(request.path),
        }),
    });
  }

  /**
   * Imports the audio of a YouTube video: yt-dlp downloads it into a temp folder under the import's
   * cancel, then it goes through the file import. The temp folder is always removed. The meeting
   * time is the import time: the downloaded file's time means nothing.
   */
  importUrl(request: ImportUrlRequest, options: ImportOptions = {}): Promise<ImportResult> {
    const video = parseYouTubeUrl(request.url);
    if (video === null) {
      return Promise.resolve({
        started: false,
        reason: 'failed',
        message: typed({ key: 'Ui_ErrorYouTubeUrl', args: [] }),
      });
    }
    const { youtube, logger } = this.deps;
    return this.run(request, options, {
      status: { key: 'Ui_StatusDownloadingYouTube', args: [] },
      prepare: async (meetingId, cancel) => {
        try {
          await youtube.ensure(cancel);
          // Once per session and before the download: a stale yt-dlp is the usual failure.
          await youtube.update();
          const path = await youtube.download(video.url, youtube.workDirectory(meetingId), cancel);
          return { ok: true, path, fileTimeMs: null };
        } catch (error) {
          const failure = youTubeFailure(error, cancel);
          if (!failure.cancelled) {
            logger.warn('the YouTube download failed', { error: describeError(error) });
          }
          return { ok: false, ...failure };
        }
      },
      release: (meetingId) => {
        youtube.removeDirectory(youtube.workDirectory(meetingId));
      },
    });
  }

  /** The import steps shared by a file and a link: gate, readiness, status, conversion, run. */
  private async run(
    request: { readonly title: string; readonly folderId: string | null },
    options: ImportOptions,
    source: ImportSource,
  ): Promise<ImportResult> {
    const { deps } = this;
    const { host } = deps;
    if (!deps.gate.tryBeginPreparing()) return { started: false, reason: 'busy', message: null };
    const preparingDone = host.trackPreparing();
    let previewStopped = false;
    let releaseFor: string | null = null;
    const cancel = new CancelSource();
    try {
      const { readiness } = await evaluateSetup(deps.setup);
      if (!readiness.canRecord) return { started: false, reason: 'not-ready', message: null };

      const meetingId = options.meetingId ?? deps.newId();
      const title = host.beginTake(options.meetingId ?? null, request.title);
      const directory = await deps.library.audioDirectory(request.folderId);
      // 173: the status, and the idle meter stops for the length of the import.
      deps.setTakeStatus(source.status);
      host.holdPreview();
      previewStopped = true;
      this.cancelSource = cancel;
      host.publish();

      releaseFor = meetingId;
      const prepared = await source.prepare(meetingId, cancel);
      const outcome = prepared.ok
        ? await this.convert(meetingId, directory, title, prepared, source.status, cancel)
        : prepared;
      if (!outcome.ok) {
        deps.setTakeStatus(outcome.message);
        host.restorePreview();
        previewStopped = false;
        return {
          started: false,
          reason: outcome.cancelled ? 'cancelled' : 'failed',
          message: typed(outcome.message),
        };
      }

      await host.process(
        {
          meetingId,
          audioPath: outcome.path,
          recordedAtMs: outcome.recordedAtMs,
          endedAtMs: outcome.endedAtMs,
          title,
          liveDraft: null,
          pausedDurationMs: 0,
          highlightsMs: [],
        },
        request.folderId,
      );
      previewStopped = false;
      return { started: true, meetingId };
    } catch (error) {
      deps.logger.warn('the import failed', { error: describeError(error) });
      const message: Message = { key: 'Error_ImportAudio', args: [describeError(error)] };
      deps.setTakeStatus(message);
      if (previewStopped) host.restorePreview();
      return { started: false, reason: 'failed', message: typed(message) };
    } finally {
      if (releaseFor !== null) source.release?.(releaseFor);
      this.cancelSource = null;
      // A no-op once processing started.
      deps.gate.cancelPreparing();
      host.publish();
      preparingDone();
    }
  }

  /** Converts the prepared file to the take WAV (spec 2.12 steps 5 and 6). */
  private convert(
    meetingId: string,
    directory: string,
    title: string,
    prepared: { readonly path: string; readonly fileTimeMs: number | null },
    status: Message,
    cancel: CancelSource,
  ): Promise<ImportConversion> {
    const { deps } = this;
    if (status.key !== IMPORTING_STATUS.key) {
      deps.setTakeStatus(IMPORTING_STATUS);
      deps.host.publish();
    }
    return convertForImport(
      {
        convert: (source, destination) => deps.controller.importAudio(source, destination),
        cancelConversion: () => {
          deps.controller.cancelImport();
        },
        allocate: (name, atMs) =>
          allocateAudioPath({
            directory,
            title: name,
            atMs,
            ownsMarkdown: (markdownPath) => deps.library.ownsMarkdown(meetingId, markdownPath),
          }),
        wavDurationSeconds: (file) => deps.files.wavDurationSeconds(file),
        remove: (file) => {
          deps.files.remove(file);
        },
        nowMs: deps.nowMs,
      },
      { source: prepared.path, title, fileTimeMs: prepared.fileTimeMs },
      cancel,
    );
  }
}
