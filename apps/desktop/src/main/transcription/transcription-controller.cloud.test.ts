import { engineStatusSchema, transcriptionEngineKindSchema } from '@vozella/contracts';
import {
  ApiProviderError,
  CLOUD_TRANSCRIPTION_ENGINES,
  createLookup,
  FakeAsrEngine,
  FakeAudioReader,
  FakeModelStore,
  FakeRuntimeStore,
  FakeSpeechTimer,
  formatFailure,
  InMemoryMeetingRepository,
  InMemorySettingsStore,
  ManualSpeechTimer,
  MeetingBusyRegistry,
  ScriptedStreamingSpeechProvider,
  TRANSCRIPTION_ENGINE_KINDS,
  type CloudTranscriptionKind,
  type Logger,
  type MeetingRecord,
  type RetranscriptionResult,
  type StreamingSpeechProvider,
} from '@vozella/core';
import {
  FakeApiKeyStore,
  FakeSpeechToTextClient,
  FakeStreamingSpeechProvider,
  TranscriptionRuntime,
  type FakeSpeechToTextOptions,
} from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { mainCatalogs } from '../i18n/main-catalogs';
import { changesTranscriptionEngine, TranscriptionController } from './transcription-controller';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const t = createLookup(mainCatalogs, 'en');
const RATE = 16_000;

const record = (patch: Partial<MeetingRecord> = {}): MeetingRecord => ({
  id: 'm1',
  title: 'Weekly',
  recordedAt: '2026-11-02T14:00:00.0000000+00:00',
  endedAt: '2026-11-02T14:52:00.0000000+00:00',
  audioFilePath: 'C:/audio/m1.wav',
  sourcePath: null,
  projectId: null,
  summaryProvider: null,
  calendarEventId: null,
  calendarId: null,
  seriesId: null,
  joinUrl: null,
  noteTemplateId: null,
  attendees: [],
  brief: null,
  transcript: '[00:00.00-00:01.00] old words',
  summary: 'kept summary',
  actionItems: [],
  jevAnalysis: null,
  notes: null,
  followUp: null,
  projectPlan: null,
  ...patch,
});

function setup(
  options: {
    engine?: CloudTranscriptionKind | null;
    key?: boolean;
    localReady?: boolean;
    speakerLabels?: boolean;
    client?: FakeSpeechToTextOptions;
    /** The streaming provider of an engine that streams; defaults to the zero-delay fake. */
    streaming?: StreamingSpeechProvider;
    /** How the app words a failure; defaults to the sentences of core. */
    formatFailure?: (error: unknown) => string;
  } = {},
) {
  const engine = new FakeAsrEngine();
  const models = new FakeModelStore();
  const runtimes = new FakeRuntimeStore();
  if (options.localReady === true) {
    models.model = true;
    runtimes.ready.add('cpu');
  }
  const settings = new InMemorySettingsStore();
  const kind = options.engine === undefined ? 'Groq' : options.engine;
  void settings.update({
    selectedSummaryProvider: null,
    transcriptionEngine: kind,
    speakerDiarizationEnabled: options.speakerLabels ?? false,
  });
  const keys = new FakeApiKeyStore(options.key === false || kind === null ? {} : { [kind]: 'k' });
  const clients: FakeSpeechToTextClient[] = [];
  const runtime = new TranscriptionRuntime({
    transcriptionModelsDirectory: 'unused',
    nemoSpeechDirectory: 'unused',
    engine,
    hardware: () => Promise.resolve({ gpuName: null }),
    logger,
    audio: new FakeAudioReader(new Float32Array(2 * RATE).fill(0.25)),
    stores: { models, runtimes },
    settings,
    cloud: {
      keys,
      client: (engineKind) => {
        const client = new FakeSpeechToTextClient({
          // An engine that streams uploads a recording with another script than its live session
          // hears, so a test can tell which of the two transcribed.
          phrases: [
            CLOUD_TRANSCRIPTION_ENGINES[engineKind].liveText === 'streaming'
              ? 'alfa beta gamma delta'
              : 'uno dos tres cuatro',
          ],
          ...options.client,
        });
        clients.push(client);
        return client;
      },
      streaming: () =>
        options.streaming ?? new FakeStreamingSpeechProvider({ phrases: ['uno dos tres cuatro'] }),
      timer: new FakeSpeechTimer(),
      // A session waits on a clock that really waits; no test here lets it run out.
      streamingTimer: new ManualSpeechTimer(),
    },
  });
  const meetings = new InMemoryMeetingRepository();
  const events: { channel: string; payload: unknown }[] = [];
  const frameListeners = new Set<(pcm: Uint8Array) => void>();
  const controller = new TranscriptionController({
    runtime,
    settings,
    meetings,
    busy: new MeetingBusyRegistry(),
    broadcast: (channel, payload) => {
      events.push({ channel: channel.name, payload });
    },
    logger,
    t,
    onRecordingFrames: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    fileExists: () => true,
    onMeetingChanged: () => undefined,
    formatFailure: options.formatFailure ?? ((error) => formatFailure(error, t)),
    defer: (task) => {
      task();
    },
  });
  return {
    controller,
    engine,
    models,
    runtimes,
    settings,
    keys,
    clients,
    meetings,
    events,
    frameListeners,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};

/** One second of mixed recording audio as the capture sends it: PCM16 in 200 ms frames. */
async function record1s(frameListeners: Set<(pcm: Uint8Array) => void>): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const pcm = new Uint8Array(new Int16Array(RATE / 5).fill(8000).buffer);
    for (const listener of frameListeners) listener(pcm);
    await flush();
  }
}

/** Waits for the run to end and returns its result. */
async function finished(
  events: { channel: string; payload: unknown }[],
): Promise<RetranscriptionResult> {
  const find = () => events.find((e) => e.channel === 'retranscription.finished');
  for (let i = 0; i < 200 && !find(); i += 1) await flush();
  const event = find();
  if (!event) throw new Error('the run did not finish');
  return event.payload as RetranscriptionResult;
}

describe('the engine kinds of the channels', () => {
  it('restate the kinds of core, in the same order', () => {
    expect(transcriptionEngineKindSchema.options).toEqual([...TRANSCRIPTION_ENGINE_KINDS]);
  });
});

describe('status with a cloud engine', () => {
  it('Local: names the engine, has no cloud reason, and keeps the Nemotron fields', async () => {
    const { controller } = setup({ engine: null, localReady: true });
    const status = await controller.status();
    expect(engineStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      engine: 'Local',
      cloudNotReadyReason: null,
      ready: true,
      modelInstalled: true,
      runtimes: { cpu: true, cuda: false },
      expectedBackend: 'cpu',
    });
  });

  it('cloud without its key: not ready, and the reason is the missing key', async () => {
    const { controller } = setup({ key: false, localReady: true });
    expect(await controller.status()).toMatchObject({
      engine: 'Groq',
      ready: false,
      cloudNotReadyReason: 'key-missing',
      // The local engine is installed, and still says so.
      modelInstalled: true,
      runtimes: { cpu: true, cuda: false },
    });
  });

  it('cloud with its key: ready with no local model on disk', async () => {
    const { controller, keys } = setup({ engine: 'OpenAi', key: false });
    await keys.set('OpenAi', 'sk-test');
    const status = await controller.status();
    expect(engineStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      engine: 'OpenAi',
      ready: true,
      cloudNotReadyReason: null,
      modelInstalled: false,
      runtimes: { cpu: false, cuda: false },
    });
  });

  it('speaker labels: the saved switch is reported and left as it is', async () => {
    const { controller, settings } = setup({ speakerLabels: true });
    expect((await controller.status()).speakerLabelsEnabled).toBe(true);
    await controller.startLive(null);
    await controller.stopLive();
    expect((await settings.load()).speakerDiarizationEnabled).toBe(true);
  });
});

describe('an engine whose live text is streamed (Deepgram)', () => {
  it('follows its key like every cloud engine: ready with it, key-missing without', async () => {
    const withKey = await setup({ engine: 'Deepgram' }).controller.status();
    expect(engineStatusSchema.parse(withKey)).toEqual(withKey);
    expect(withKey).toMatchObject({ engine: 'Deepgram', ready: true, cloudNotReadyReason: null });
    const noKey = setup({ engine: 'Deepgram', key: false });
    expect(await noKey.controller.status()).toMatchObject({
      engine: 'Deepgram',
      ready: false,
      cloudNotReadyReason: 'key-missing',
    });
    expect(await noKey.controller.ensureEngine()).toEqual({
      status: 'failed',
      message: 'Deepgram needs your API key. Add it in Settings.',
    });
    expect(noKey.models.downloads).toEqual([]);
    expect(noKey.clients).toEqual([]);
  });

  it('a clean live pass streams word by word, uploads nothing, and vouches for the draft', async () => {
    const { controller, clients, engine, frameListeners, events } = setup({ engine: 'Deepgram' });
    expect(await controller.startLive(null)).toEqual({ active: true });
    await record1s(frameListeners);
    await record1s(frameListeners);
    const draft = await controller.stopLive();
    expect(draft).toBe('[00:00.00-00:01.90] uno dos tres cuatro');
    const updates = events
      .filter((e) => e.channel === 'transcription.liveUpdate')
      .map((e) => e.payload as { displayText: string; committedText: string });
    // The words were on screen before the phrase was committed.
    expect(updates[0]).toEqual({ displayText: '[00:00.00-00:00.40] uno', committedText: '' });
    expect(updates.at(-1)?.committedText).toBe(draft);
    // Nothing was lost: the pass after Stop would only send the same audio again.
    expect(controller.liveDraftIsFinal).toBe(true);
    expect(clients).toEqual([]);
    expect(engine.recognizers).toHaveLength(0);
  });

  it.each([
    ['KeyInvalid', 'Fake streaming speech did not accept your API key. Check it in Settings.'],
    [
      'QuotaExceeded',
      'Your Fake streaming speech account is out of credit or quota. Check your plan with Fake streaming speech.',
    ],
  ])('a session refused as %s tells the recording why, once', async (failWith, sentence) => {
    const { controller, frameListeners } = setup({
      engine: 'Deepgram',
      streaming: new FakeStreamingSpeechProvider({ failWith }),
    });
    const reasons: string[] = [];
    controller.onLiveFailure((reason) => reasons.push(reason));
    await controller.startLive(null);
    await record1s(frameListeners);
    expect(reasons).toEqual([sentence]);
    // The take goes on, and what is recorded after it is not a second notice.
    await record1s(frameListeners);
    expect(await controller.stopLive()).toBe('');
    expect(reasons).toEqual([sentence]);
    expect(controller.liveDraftIsFinal).toBe(false);
  });

  it('a connection that drops mid-recording: no notice, a draft that is not final, and the pass after Stop uploads', async () => {
    const provider = new ScriptedStreamingSpeechProvider();
    const { controller, frameListeners, clients } = setup({
      engine: 'Deepgram',
      streaming: provider,
    });
    const reasons: string[] = [];
    controller.onLiveFailure((reason) => reasons.push(reason));
    await controller.startLive(null);
    await record1s(frameListeners);
    const session = provider.sessions[0];
    if (session === undefined) throw new Error('no session was opened');
    session.listener.opened();
    session.listener.final({
      text: 'uno dos',
      words: [
        { text: 'uno', startMs: 0, endMs: 400 },
        { text: 'dos', startMs: 500, endMs: 900 },
      ],
      processedMs: 1_000,
    });
    await record1s(frameListeners);
    session.listener.closed(new ApiProviderError('Scripted', 'Network'));
    // The recording is still running and still feeding the live pass.
    await record1s(frameListeners);
    expect(await controller.stopLive()).toBe('[00:00.00-00:00.90] uno dos');
    expect(reasons).toEqual([]);
    expect(controller.liveDraftIsFinal).toBe(false);
    expect((await controller.status()).liveDroppedPercent).toBeGreaterThan(0);
    // The pass after Stop is the prerecorded upload of the whole recording.
    expect(clients).toEqual([]);
    const text = await controller.transcribeFile({ audioPath: 'C:/a.wav', recordedAtMs: null });
    expect(text).toBe('[00:00.00-00:01.90] alfa beta gamma delta');
    expect(clients).toHaveLength(1);
    expect(clients[0]?.requests).toHaveLength(1);
  });

  it('a re-transcription uploads the recording and replaces the transcript', async () => {
    const { controller, meetings, events, clients } = setup({ engine: 'Deepgram' });
    await meetings.save(record());
    await controller.startRetranscription('m1');
    expect((await finished(events)).outcome).not.toBe('Failed');
    expect((await meetings.get('m1'))?.transcript).toContain('alfa beta gamma delta');
    expect(clients).toHaveLength(1);
  });
});

describe('the status after the engine setting or a key changed', () => {
  const published = (events: { channel: string; payload: unknown }[]) =>
    events
      .filter((e) => e.channel === 'transcription.statusChanged')
      .map((e) => e.payload as { engine: string; ready: boolean; cloudNotReadyReason: unknown });

  it('is published again with the engine the setting now selects', async () => {
    const { controller, settings, events } = setup({ engine: null, localReady: true });
    await settings.update({ transcriptionEngine: 'OpenAi' });
    await controller.refreshStatus();
    expect(published(events)).toEqual([
      expect.objectContaining({
        engine: 'OpenAi',
        ready: false,
        cloudNotReadyReason: 'key-missing',
      }),
    ]);
  });

  it('only a patch that names the engine or its model makes the status stale', () => {
    expect(changesTranscriptionEngine({ transcriptionEngine: 'Groq' })).toBe(true);
    expect(changesTranscriptionEngine({ transcriptionEngine: null })).toBe(true);
    expect(changesTranscriptionEngine({ cloudTranscriptionModelId: 'whisper-large-v3' })).toBe(
      true,
    );
    expect(changesTranscriptionEngine({ uiLanguage: 'es', meetingPopupEnabled: false })).toBe(
      false,
    );
    expect(changesTranscriptionEngine({})).toBe(false);
  });

  it('is published again as ready once the key is stored, and not ready once it is removed', async () => {
    const { controller, keys, events } = setup({ key: false });
    await keys.set('Groq', 'gsk-test');
    await controller.refreshStatus();
    await keys.delete('Groq');
    await controller.refreshStatus();
    expect(published(events).map((status) => status.ready)).toEqual([true, false]);
  });
});

describe('a live pass the provider refuses', () => {
  it('tells its listeners once, with the sentence of the failure', async () => {
    const { controller, frameListeners } = setup({ client: { failWith: 'KeyInvalid' } });
    const reasons: string[] = [];
    const off = controller.onLiveFailure((reason) => reasons.push(reason));
    await controller.startLive(null);
    await record1s(frameListeners);
    await controller.stopLive();
    expect(reasons).toEqual(['Fake speech did not accept your API key. Check it in Settings.']);
    off();
  });

  it('says nothing for a failure that only leaves a gap', async () => {
    const { controller, frameListeners } = setup({ client: { failWith: 'RateLimited' } });
    const reasons: string[] = [];
    controller.onLiveFailure((reason) => reasons.push(reason));
    await controller.startLive(null);
    await record1s(frameListeners);
    await controller.stopLive();
    expect(reasons).toEqual([]);
  });
});

describe('ensureEngine with a cloud engine', () => {
  it('is ready at once with the key, and downloads nothing', async () => {
    const { controller, models, runtimes, events } = setup();
    expect(await controller.ensureEngine()).toEqual({ status: 'ready' });
    expect(models.downloads).toEqual([]);
    expect(runtimes.downloads).toEqual([]);
    expect(events.some((e) => e.channel === 'transcription.installProgress')).toBe(false);
  });

  it('asked for the local engine, downloads it and leaves the cloud engine selected', async () => {
    const { controller, models, runtimes, settings } = setup({ key: false });
    expect(await controller.ensureEngine({ local: true })).toEqual({ status: 'ready' });
    expect(models.downloads.length + runtimes.downloads.length).toBeGreaterThan(0);
    expect(models.isModelDownloaded()).toBe(true);
    expect((await settings.load()).transcriptionEngine).toBe('Groq');
    // The selected engine is still the cloud one, and it still has no key.
    expect(await controller.status()).toMatchObject({
      engine: 'Groq',
      ready: false,
      modelInstalled: true,
    });
  });

  it('fails with the missing-key sentence without the key, and downloads nothing', async () => {
    const { controller, models, runtimes } = setup({ key: false });
    expect(await controller.ensureEngine()).toEqual({
      status: 'failed',
      message: 'Groq needs your API key. Add it in Settings.',
    });
    expect(models.downloads).toEqual([]);
    expect(runtimes.downloads).toEqual([]);
  });
});

describe('live pass with a cloud engine', () => {
  it('transcribes through the cloud client, without speaker labels, and vouches for the draft', async () => {
    const { controller, engine, clients, frameListeners, events } = setup({ speakerLabels: true });
    expect(await controller.startLive(null)).toEqual({ active: true });
    await record1s(frameListeners);
    const draft = await controller.stopLive();
    expect(draft).toBe('[00:00.00-00:00.90] uno dos');
    expect(clients).toHaveLength(1);
    expect(clients[0]?.requests).toHaveLength(1);
    expect(engine.recognizers).toHaveLength(0);
    expect(controller.liveDraftIsFinal).toBe(true);
    const updates = events.filter((e) => e.channel === 'transcription.liveUpdate');
    expect((updates.at(-1)?.payload as { committedText: string }).committedText).toBe(draft);
  });

  it('a failed piece leaves a draft that is not final', async () => {
    const { controller, frameListeners } = setup({ client: { failWith: 'RateLimited' } });
    await controller.startLive(null);
    await record1s(frameListeners);
    expect(await controller.stopLive()).toBe('');
    expect(controller.liveDraftIsFinal).toBe(false);
  });

  it('the local engine never marks its draft final', async () => {
    const { controller, engine, frameListeners } = setup({ engine: null, localReady: true });
    engine.script = {
      afterPush: [
        [
          {
            isFinal: true,
            transcript: 'hola',
            audioProcessedSeconds: 1,
            words: [{ startMs: 0, endMs: 1000, speakerTag: 0, text: null }],
          },
        ],
      ],
    };
    await controller.startLive(null);
    await record1s(frameListeners);
    expect(await controller.stopLive()).toBe('[00:00.00-00:01.00] hola');
    expect(controller.liveDraftIsFinal).toBe(false);
  });

  it('a new take forgets the last one', async () => {
    const { controller, frameListeners } = setup();
    await controller.startLive(null);
    await record1s(frameListeners);
    await controller.stopLive();
    expect(controller.liveDraftIsFinal).toBe(true);
    await controller.startLive(null);
    expect(controller.liveDraftIsFinal).toBe(false);
    await controller.stopLive();
  });
});

describe('offline pass with a cloud engine', () => {
  it('transcribes the file through the cloud client', async () => {
    const { controller, engine } = setup();
    const text = await controller.transcribeFile({ audioPath: 'C:/a.wav', recordedAtMs: null });
    expect(text).toBe('[00:00.00-00:01.90] uno dos tres cuatro');
    expect(engine.recognizers).toHaveLength(0);
  });

  it('a failure leaves as the API failure, for the pipeline to word', async () => {
    const { controller } = setup({ client: { failWith: 'KeyInvalid' } });
    const run = controller.transcribeFile({ audioPath: 'C:/a.wav', recordedAtMs: null });
    await expect(run).rejects.toMatchObject({ name: 'ApiProviderError', kind: 'KeyInvalid' });
  });
});

describe('re-transcription with a cloud engine', () => {
  it('replaces the transcript with the key and no local engine', async () => {
    const { controller, meetings, events } = setup();
    await meetings.save(record());
    expect(await controller.startRetranscription('m1')).toEqual({ started: true, reason: null });
    expect((await finished(events)).outcome).toBe('TranscriptOnly');
    expect((await meetings.get('m1'))?.transcript).toContain('uno dos tres cuatro');
  });

  it('without the key it says which key is missing and keeps the transcript', async () => {
    const { controller, meetings, events } = setup({ key: false, localReady: true });
    await meetings.save(record());
    await controller.startRetranscription('m1');
    expect(await finished(events)).toMatchObject({
      outcome: 'Failed',
      message: 'Groq needs your API key. Add it in Settings.',
    });
    expect((await meetings.get('m1'))?.transcript).toBe('[00:00.00-00:01.00] old words');
  });

  it('a failed upload keeps the audio message with the API failure sentence', async () => {
    const { controller, meetings, events } = setup({ client: { failWith: 'QuotaExceeded' } });
    await meetings.save(record());
    await controller.startRetranscription('m1');
    const result = await finished(events);
    expect(result.outcome).toBe('Failed');
    expect(result.message).toBe(
      t(
        'Error_TranscriptionFailedAudioKept',
        'Your Fake speech account is out of credit or quota. Check your plan with Fake speech.',
      ),
    );
    expect((await meetings.get('m1'))?.transcript).toBe('[00:00.00-00:01.00] old words');
  });

  it('a failure of the engine on this PC keeps its own message: only API failures are reworded', async () => {
    const { controller, engine, meetings, events } = setup({
      engine: null,
      localReady: true,
      formatFailure: () => 'a sentence written for another module',
    });
    engine.script = { pushError: new Error('the native engine stopped') };
    await meetings.save(record());
    await controller.startRetranscription('m1');
    const result = await finished(events);
    expect(result.outcome).toBe('Failed');
    expect(result.message).toBe(
      t('Error_TranscriptionFailedAudioKept', 'the native engine stopped'),
    );
  });
});
