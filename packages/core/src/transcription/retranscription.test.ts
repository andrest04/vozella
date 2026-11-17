import { describe, expect, it, vi } from 'vitest';
import type { MeetingRecord } from '../library/meeting';
import { resolveTranscriptionStage } from './pipeline-rules';
import {
  createRetranscriptionRequest,
  evaluateRetranscription,
  MeetingRetranscriptionRunner,
  type RecordingPipelineRequest,
  type RetranscriptionPipeline,
  type RetranscriptionPipelineCallbacks,
  type RetranscriptionResult,
} from './retranscription';

const record = (patch: Partial<MeetingRecord> = {}): MeetingRecord => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Weekly',
  recordedAt: '2026-11-02T14:00:00.0000000+00:00',
  endedAt: '2026-11-02T14:52:00.0000000+00:00',
  audioFilePath: 'C:/audio/a.wav',
  sourcePath: null,
  folderId: 'folder-1',
  summaryProvider: null,
  calendarEventId: 'ev',
  calendarId: 'cal',
  seriesId: 'series',
  joinUrl: 'https://join',
  noteTemplateId: 'tpl',
  attendees: ['a@x', 'b@x'],
  brief: 'brief',
  transcript: '[00:00.00-00:01.00] one\n* [00:05.00-00:06.00] two',
  summary: 'old',
  actionItems: [],
  jevAnalysis: null,
  notes: 'my notes',
  followUp: null,
  projectPlan: null,
  ...patch,
});

describe('retranscription availability', () => {
  it('Evaluate_AudioExistsAndIdle_IsAvailable', () => {
    expect(evaluateRetranscription(record(), false, () => true)).toBe('Available');
  });
  it('Evaluate_AudioFileMissing_IsNoAudio', () => {
    expect(evaluateRetranscription(record(), false, () => false)).toBe('NoAudio');
  });
  it('Evaluate_BlankAudioPath_IsNoAudioWithoutProbingTheDisk', () => {
    const probe = vi.fn(() => true);
    expect(evaluateRetranscription(record({ audioFilePath: '  ' }), false, probe)).toBe('NoAudio');
    expect(probe).not.toHaveBeenCalled();
  });
  it('Evaluate_NullRecord_IsNoAudio', () => {
    expect(evaluateRetranscription(null, false, () => true)).toBe('NoAudio');
  });
  it('Evaluate_AudioExistsButBusy_IsBusy', () => {
    expect(evaluateRetranscription(record(), true, () => true)).toBe('Busy');
  });
  it('Evaluate_ChecksTheRecordedAudioPath', () => {
    const probe = vi.fn(() => true);
    evaluateRetranscription(record(), false, probe);
    expect(probe).toHaveBeenCalledWith('C:/audio/a.wav');
  });
  it('Evaluate_MissingAudioWinsOverBusy', () => {
    expect(evaluateRetranscription(record(), true, () => false)).toBe('NoAudio');
  });
});

describe('retranscription request', () => {
  it('CreateRequest_DropsLiveDraftSoTheOfflinePassBecomesTheTranscript', () => {
    const request = createRetranscriptionRequest(record(), null);
    expect(request.liveDraft).toBeNull();
    expect(request.pausedSeconds).toBe(0);
  });
  it('CreateRequest_KeepsMeetingContextSoTheSavedRecordDoesNotLoseIt', () => {
    const request = createRetranscriptionRequest(record(), 'be brief');
    expect(request).toMatchObject({
      meetingId: '11111111-1111-1111-1111-111111111111',
      title: 'Weekly',
      folderId: 'folder-1',
      calendarEventId: 'ev',
      calendarId: 'cal',
      seriesId: 'series',
      joinUrl: 'https://join',
      attendees: ['a@x', 'b@x'],
      brief: 'brief',
      agenda: null,
      noteTemplateId: 'tpl',
      templateInstructions: 'be brief',
    });
  });
  it('CreateRequest_MissingEndedAt_KeepsItUnknown', () => {
    expect(createRetranscriptionRequest(record({ endedAt: null }), null).endedAt).toBeNull();
  });
  it('B8: the starred lines of the old transcript come back as highlights', () => {
    expect(createRetranscriptionRequest(record(), null).highlightsMs).toEqual([5000]);
    expect(createRetranscriptionRequest(record({ transcript: null }), null).highlightsMs).toEqual(
      [],
    );
  });
});

describe('MeetingRetranscriptionRunner', () => {
  const run = async (
    script: (
      cb: RetranscriptionPipelineCallbacks,
      request: RecordingPipelineRequest,
    ) => void | Promise<void>,
  ) => {
    const states: string[] = [];
    const results: RetranscriptionResult[] = [];
    const changed: string[] = [];
    const pipeline: RetranscriptionPipeline = {
      run: async (request, callbacks) => {
        await script(callbacks, request);
      },
    };
    const runner = new MeetingRetranscriptionRunner({
      pipeline,
      templateInstructions: () => Promise.resolve(null),
      formatFailure: (e) => `formatted: ${e instanceof Error ? e.message : String(e)}`,
      startStatus: 'Transcribing audio...',
      defer: (task) => {
        task();
      },
      onMeetingChanged: (id) => changed.push(id),
    });
    runner.onStateChanged(() => states.push(runner.current.status));
    runner.onFinished((r) => results.push(r));
    await runner.start(record());
    return { runner, states, results, changed };
  };

  it('outcome precedence: SummaryFailed > Failed > Completed > Cancelled > TranscriptOnly', async () => {
    const all = await run((cb) => {
      cb.onMeetingCompleted();
      cb.onFinished('x');
      cb.onSummaryFailedAfterTranscriptSaved('summary broke');
    });
    expect(all.results[0]).toMatchObject({ outcome: 'SummaryFailed', message: 'summary broke' });

    const failed = await run((cb) => {
      cb.onMeetingCompleted();
      cb.onFinished('transcription failed');
    });
    expect(failed.results[0]).toMatchObject({ outcome: 'Failed', message: 'transcription failed' });

    const completed = await run((cb) => {
      cb.onMeetingCompleted();
    });
    expect(completed.results[0]).toMatchObject({ outcome: 'Completed', message: null });

    const transcriptOnly = await run(() => undefined);
    expect(transcriptOnly.results[0]).toMatchObject({ outcome: 'TranscriptOnly', message: null });
  });

  it('a cancel is not a failure, before or during the pipeline', async () => {
    const results: RetranscriptionResult[] = [];
    const runner: MeetingRetranscriptionRunner = new MeetingRetranscriptionRunner({
      pipeline: {
        run: (_request, cb) => {
          runner.cancel();
          cb.onFinished('Cancelled by user');
          return Promise.reject(new Error('aborted'));
        },
      },
      templateInstructions: () => Promise.resolve(null),
      formatFailure: String,
      defer: (t) => {
        t();
      },
      onMeetingChanged: () => undefined,
    });
    runner.onFinished((r) => results.push(r));
    await runner.start(record());
    expect(results[0]).toMatchObject({ outcome: 'Cancelled', message: null });
  });

  it('126: a cancel before the pipeline starts never runs the pipeline and ends as Cancelled', async () => {
    const results: RetranscriptionResult[] = [];
    const pipelineRun = vi.fn(() => Promise.resolve());
    const runner: MeetingRetranscriptionRunner = new MeetingRetranscriptionRunner({
      pipeline: { run: pipelineRun },
      templateInstructions: () => {
        runner.cancel();
        return Promise.resolve(null);
      },
      formatFailure: String,
      defer: (t) => {
        t();
      },
      onMeetingChanged: () => undefined,
    });
    runner.onFinished((r) => results.push(r));
    await runner.start(record());
    expect(pipelineRun).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ outcome: 'Cancelled', message: null });
  });

  it('129: the terminal step is queued behind progress callbacks that were already queued', async () => {
    const order: string[] = [];
    const runner = new MeetingRetranscriptionRunner({
      pipeline: {
        run: (_request, cb) => {
          // Progress that arrives late, queued on the same task queue.
          void Promise.resolve().then(() => {
            cb.onStatus('late 99%');
            order.push('progress');
          });
          return Promise.resolve();
        },
      },
      templateInstructions: () => Promise.resolve(null),
      formatFailure: String,
      defer: (t) => {
        void Promise.resolve()
          .then(() => undefined)
          .then(t);
      },
      onMeetingChanged: () => undefined,
    });
    const finished = new Promise<void>((resolve) => {
      runner.onFinished(() => {
        order.push('finished');
        resolve();
      });
    });
    await runner.start(record());
    expect(runner.current.isRunning).toBe(true);
    await finished;
    expect(order).toEqual(['progress', 'finished']);
    expect(runner.current.isRunning).toBe(false);
  });

  it('an exception becomes a Failed outcome with the formatted message', async () => {
    const out = await run(() => {
      throw new Error('disk full');
    });
    expect(out.results[0]).toMatchObject({ outcome: 'Failed', message: 'formatted: disk full' });
  });

  it('starts with the transcribing status, follows the pipeline, and resets before Finished', async () => {
    const out = await run((cb) => {
      cb.onStatus('Transcribing audio... 40%');
      cb.onMeetingSaved('m1');
    });
    expect(out.states[0]).toBe('Transcribing audio...');
    expect(out.states).toContain('Transcribing audio... 40%');
    expect(out.changed).toEqual(['m1']);
    expect(out.runner.current).toEqual({ isRunning: false, meetingId: null, status: '' });
    expect(out.results).toHaveLength(1);
  });

  it('resets IsRunning, MeetingId and Status before Finished is raised', async () => {
    const out = await run(() => undefined);
    const seen: unknown[] = [];
    out.runner.onFinished(() => seen.push({ ...out.runner.current }));
    await out.runner.start(record());
    expect(seen).toEqual([{ isRunning: false, meetingId: null, status: '' }]);
  });

  it('only one run at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new MeetingRetranscriptionRunner({
      pipeline: { run: () => gate },
      templateInstructions: () => Promise.resolve(null),
      formatFailure: String,
      defer: (t) => {
        t();
      },
      onMeetingChanged: () => undefined,
    });
    const first = runner.start(record());
    await Promise.resolve();
    expect(runner.current.isRunning).toBe(true);
    expect(await runner.start(record())).toBe(false);
    release();
    expect(await first).toBe(true);
  });
});

describe('MeetingRetranscriptionRunner last result and cancel precedence', () => {
  const make = (
    script: (
      cb: RetranscriptionPipelineCallbacks,
      runner: MeetingRetranscriptionRunner,
    ) => void | Promise<void>,
  ) => {
    const events: string[] = [];
    const runner: MeetingRetranscriptionRunner = new MeetingRetranscriptionRunner({
      pipeline: { run: async (_r, cb) => script(cb, runner) },
      templateInstructions: () => Promise.resolve(null),
      formatFailure: (e) => (e instanceof Error ? e.message : String(e)),
      defer: (t) => {
        t();
      },
      onMeetingChanged: () => undefined,
    });
    runner.onStateChanged(() =>
      events.push(`state:${runner.current.isRunning ? 'running' : 'idle'}`),
    );
    runner.onFinished((r) => events.push(`finished:${r.outcome}`));
    return { runner, events };
  };

  it('B7: keeps the last result per meeting until the next run or a dismiss', async () => {
    let fail = true;
    const { runner } = make((cb) => {
      if (fail) cb.onFinished('boom');
    });
    await runner.start(record());
    expect(runner.lastResults).toEqual([
      { meetingId: record().id, outcome: 'Failed', message: 'boom' },
    ]);
    // A different meeting keeps its own entry.
    await runner.start(record({ id: 'other' }));
    expect(runner.lastResults.map((r) => r.meetingId).sort()).toEqual(
      ['other', record().id].sort(),
    );
    fail = false;
    await runner.start(record());
    expect(runner.lastResults.find((r) => r.meetingId === record().id)?.outcome).toBe(
      'TranscriptOnly',
    );
    runner.dismiss(record().id);
    expect(runner.lastResults.map((r) => r.meetingId)).toEqual(['other']);
  });

  it('B7: the old result is cleared as soon as the next run starts', async () => {
    let first = true;
    const { runner } = make((cb) => {
      if (first) cb.onFinished('first');
    });
    await runner.start(record());
    first = false;
    const seen: number[] = [];
    runner.onStateChanged(() => {
      if (runner.current.isRunning) seen.push(runner.lastResults.length);
    });
    await runner.start(record());
    expect(seen[0]).toBe(0);
  });

  it('B18: a failure recorded before the cancel stays a failure', async () => {
    const { runner } = make((cb, r) => {
      cb.onFinished('real failure');
      r.cancel();
    });
    const results: RetranscriptionResult[] = [];
    runner.onFinished((x) => results.push(x));
    await runner.start(record());
    expect(results[0]).toMatchObject({ outcome: 'Failed', message: 'real failure' });
  });

  it('B18: a failure reported after the cancel is ignored (parity 130 to 132)', async () => {
    const { runner } = make((cb, r) => {
      r.cancel();
      cb.onFinished('late failure');
    });
    const results: RetranscriptionResult[] = [];
    runner.onFinished((x) => results.push(x));
    await runner.start(record());
    expect(results[0]).toMatchObject({ outcome: 'Cancelled', message: null });
  });

  it('a summary failure beats a cancel that came after it', async () => {
    const { runner } = make((cb, r) => {
      cb.onSummaryFailedAfterTranscriptSaved('no summary');
      r.cancel();
    });
    const results: RetranscriptionResult[] = [];
    runner.onFinished((x) => results.push(x));
    await runner.start(record());
    expect(results[0]).toMatchObject({ outcome: 'SummaryFailed' });
  });

  it('B17: the state change to idle is raised before finished', async () => {
    const { runner, events } = make(() => undefined);
    await runner.start(record());
    expect(events).toEqual(['state:running', 'state:idle', 'finished:TranscriptOnly']);
  });
});

describe('pipeline transcript choice', () => {
  it('picks offline text, then the draft, then the error outcomes', () => {
    expect(resolveTranscriptionStage('draft', 'offline', true)).toBe('OfflineTranscript');
    expect(resolveTranscriptionStage('draft', '  ', true)).toBe('LiveDraftAfterFailure');
    expect(resolveTranscriptionStage('draft', null, false)).toBe('LiveDraft');
    expect(resolveTranscriptionStage(null, '', true)).toBe('FailedWithoutTranscript');
    expect(resolveTranscriptionStage(' ', '', false)).toBe('NoTranscript');
  });
});
