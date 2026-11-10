import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CancelSource,
  CancelledError,
  InMemorySettingsStore,
  RecordingSessionGate,
  type CancelSignal,
  type Message,
  type PipelineRequest,
} from '@vozella/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertForImport,
  ImportRun,
  type ImportConversionDeps,
  type ImportHost,
} from './import-run';

const WAV = 'C:/Inbox/2026-11-03 Call.wav';

function build(over: Partial<ImportConversionDeps> = {}) {
  const removed: string[] = [];
  const deps: ImportConversionDeps = {
    convert: vi.fn(() => Promise.resolve()),
    cancelConversion: vi.fn(),
    allocate: vi.fn(() => WAV),
    wavDurationSeconds: () => 90,
    remove: (file) => {
      removed.push(file);
    },
    nowMs: () => 5_000_000,
    ...over,
  };
  return { deps, removed };
}
const request = { source: 'C:/in/call.mp3', title: 'Call', fileTimeMs: 10_000_000 };

describe('convertForImport', () => {
  it('B-19: the file time is the end and the start is derived from the duration (169)', async () => {
    const { deps } = build();
    const result = await convertForImport(deps, request, new CancelSource());
    expect(result).toEqual({
      ok: true,
      path: WAV,
      recordedAtMs: 10_000_000 - 90_000,
      endedAtMs: 10_000_000,
    });
  });

  it('allocates at the file time, and at now when the file time is unreadable (170)', async () => {
    const { deps } = build();
    await convertForImport(deps, { ...request, fileTimeMs: null }, new CancelSource());
    expect(deps.allocate).toHaveBeenCalledWith('Call', 5_000_000);
  });

  it('removes the partial WAV and reports Error_ImportAudio on a conversion failure (171)', async () => {
    const { deps, removed } = build({ convert: () => Promise.reject(new Error('bad codec')) });
    const result = await convertForImport(deps, request, new CancelSource());
    expect(result).toEqual({
      ok: false,
      cancelled: false,
      message: { key: 'Error_ImportAudio', args: ['bad codec'] },
    });
    expect(removed).toEqual([WAV]);
  });

  it('reports a failed allocation as the same error and removes nothing', async () => {
    const { deps, removed } = build({ allocate: () => Promise.reject(new Error('disk')) });
    const result = await convertForImport(deps, request, new CancelSource());
    expect(result).toMatchObject({ ok: false, message: { key: 'Error_ImportAudio' } });
    expect(removed).toEqual([]);
  });

  it('a cancel stops the conversion, removes the partial WAV and is not an error (170)', async () => {
    const cancel = new CancelSource();
    const { deps, removed } = build({
      convert: () => {
        cancel.cancel();
        return Promise.reject(new Error('aborted'));
      },
    });
    const result = await convertForImport(deps, request, cancel);
    expect(deps.cancelConversion).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(removed).toHaveLength(1);
  });

  it('a cancel that arrives as the conversion succeeds still removes the file', async () => {
    const cancel = new CancelSource();
    const { deps, removed } = build({
      convert: () => {
        cancel.cancel();
        return Promise.resolve();
      },
    });
    expect(await convertForImport(deps, request, cancel)).toMatchObject({ cancelled: true });
    expect(removed).toHaveLength(1);
  });
});

describe('ImportRun', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-import-run-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(over: { ready?: boolean; convertError?: Error; holdDownload?: boolean } = {}) {
    const gate = new RecordingSessionGate();
    const log: string[] = [];
    const statuses: string[] = [];
    const processed: { request: Omit<PipelineRequest, 'folderId'>; folderId: string | null }[] = [];
    const youtubeCalls: string[] = [];
    const settings = new InMemorySettingsStore();
    void settings.update({ selectedSummaryProvider: 'ClaudeCode' });
    const host: ImportHost = {
      beginTake: (meetingId, title) => {
        log.push(`beginTake:${String(meetingId)}:${title}`);
        return title === '' ? 'Placeholder' : title;
      },
      holdPreview: () => log.push('holdPreview'),
      restorePreview: () => log.push('restorePreview'),
      publish: () => log.push('publish'),
      trackPreparing: () => {
        log.push('trackPreparing');
        return () => log.push('settled');
      },
      process: (request, folderId) => {
        log.push('process');
        processed.push({ request, folderId });
        return Promise.resolve();
      },
    };
    const run = new ImportRun({
      gate,
      setTakeStatus: (message: Message) => {
        statuses.push(message.key);
      },
      host,
      setup: {
        loadSettings: () => settings.load(),
        localModelFileExists: () => Promise.resolve(false),
        cliOnPath: () => Promise.resolve(over.ready ?? true),
        engineReady: () => Promise.resolve(true),
      },
      controller: {
        importAudio: (_source, destination) => {
          log.push('convert');
          fs.writeFileSync(destination, 'RIFF');
          return over.convertError ? Promise.reject(over.convertError) : Promise.resolve();
        },
        cancelImport: () => log.push('cancelImport'),
      },
      library: {
        audioDirectory: () => Promise.resolve(root),
        ownsMarkdown: () => Promise.resolve(false),
      },
      files: {
        remove: (file) => {
          fs.rmSync(file, { force: true });
        },
        fileTimeMs: () => 2_000_000,
        wavDurationSeconds: () => 30,
      },
      youtube: {
        ensure: () => Promise.resolve(),
        update: () => Promise.resolve(),
        download: async (_url: string, directory: string, cancel: CancelSignal) => {
          youtubeCalls.push('download');
          if (over.holdDownload) {
            await new Promise<void>((resolve) => cancel.onCancel(resolve));
            throw new CancelledError();
          }
          return path.join(directory, 'abc.m4a');
        },
        workDirectory: (meetingId) => path.join(root, 'yt', meetingId),
        removeDirectory: () => youtubeCalls.push('removeDirectory'),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 5_000_000,
      newId: () => 'meeting-1',
    });
    return { run, gate, log, statuses, processed, youtubeCalls };
  }

  const picked = { title: 'Call', folderId: 'f-1', path: 'C:/in/call.mp3' };

  it('runs a file import on the host in order and hands the WAV to the pipeline', async () => {
    const t = setup();
    expect(await t.run.importAudio(picked)).toEqual({ started: true, meetingId: 'meeting-1' });
    expect(t.log).toEqual([
      'trackPreparing',
      'beginTake:null:Call',
      'holdPreview',
      'publish',
      'convert',
      'process',
      'publish',
      'settled',
    ]);
    expect(t.statuses).toEqual(['Status_Importing']);
    expect(t.processed[0]?.folderId).toBe('f-1');
    expect(t.processed[0]?.request).toMatchObject({
      meetingId: 'meeting-1',
      title: 'Call',
      recordedAtMs: 2_000_000 - 30_000,
      endedAtMs: 2_000_000,
      liveDraft: null,
      pausedDurationMs: 0,
      highlightsMs: [],
    });
  });

  it('a linked meeting id is the id of the import and of the take', async () => {
    const t = setup();
    expect(await t.run.importAudio(picked, { meetingId: 'm-9' })).toMatchObject({
      meetingId: 'm-9',
    });
    expect(t.log).toContain('beginTake:m-9:Call');
  });

  it('uses the shared gate: busy while the session is held, and frees it on failure', async () => {
    const t = setup({ convertError: new Error('bad codec') });
    expect(t.gate.tryBeginPreparing()).toBe(true);
    expect(await t.run.importAudio(picked)).toEqual({
      started: false,
      reason: 'busy',
      message: null,
    });
    expect(t.log).toEqual([]);
    t.gate.cancelPreparing();
    expect(await t.run.importAudio(picked)).toMatchObject({
      reason: 'failed',
      message: { key: 'Error_ImportAudio', args: ['bad codec'] },
    });
    expect(t.log).toContain('restorePreview');
    expect(t.log).not.toContain('process');
    expect(t.gate.phase).toBe('Idle');
  });

  it('does nothing past the setup gate when the app is not ready', async () => {
    const t = setup({ ready: false });
    expect(await t.run.importAudio(picked)).toEqual({
      started: false,
      reason: 'not-ready',
      message: null,
    });
    expect(t.log).toEqual(['trackPreparing', 'publish', 'settled']);
  });

  it('cancel is false with no import, and stops a download in flight', async () => {
    const t = setup({ holdDownload: true });
    expect(t.run.cancel()).toBe(false);
    const running = t.run.importUrl({
      title: 'Talk',
      folderId: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    await vi.waitFor(() => {
      expect(t.youtubeCalls).toContain('download');
    });
    expect(t.statuses).toEqual(['Ui_StatusDownloadingYouTube']);
    expect(t.run.cancel()).toBe(true);
    expect(await running).toMatchObject({ started: false, reason: 'cancelled' });
    expect(t.youtubeCalls).toEqual(['download', 'removeDirectory']);
    expect(t.run.cancel()).toBe(false);
    expect(t.gate.phase).toBe('Idle');
  });
});
