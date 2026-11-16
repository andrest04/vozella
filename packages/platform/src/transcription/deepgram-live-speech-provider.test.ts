import {
  ApiProviderError,
  CancelSource,
  ManualSpeechTimer,
  type ApiFailureKind,
  type CancelSignal,
  type StreamingSpeechListener,
  type StreamingSpeechResult,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { ScriptedLiveSockets } from '../fakes/scripted-live-socket';
import {
  DEEPGRAM_KEEP_ALIVE_MS,
  DeepgramLiveSpeechProvider,
} from './deepgram-live-speech-provider';

const KEY = 'dg-live-secret-0123456789';
const RATE = 16_000;

type Heard =
  | { readonly event: 'opened' }
  | { readonly event: 'interim' | 'final'; readonly result: StreamingSpeechResult }
  | { readonly event: 'closed'; readonly error: ApiProviderError | null };

/** Lets the key read and every other promise that can settle without more input settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

interface Setup {
  readonly key?: string | null;
  readonly language?: string;
  /** What the key check answers when a session never opens: resolves, or fails with this kind. */
  readonly keyCheck?: ApiFailureKind | null;
  readonly cancel?: CancelSignal;
}

async function start(setup: Setup = {}) {
  const sockets = new ScriptedLiveSockets();
  const timer = new ManualSpeechTimer();
  const heard: Heard[] = [];
  const keyChecks: string[] = [];
  const key = setup.key === undefined ? KEY : setup.key;
  const provider = new DeepgramLiveSpeechProvider({
    displayName: 'Deepgram',
    baseUrl: 'https://api.deepgram.com/v1',
    model: 'nova-3',
    apiKey: () => Promise.resolve(key),
    timer,
    socket: sockets.factory,
    checkKey: (checked) => {
      keyChecks.push(checked);
      const kind = setup.keyCheck ?? null;
      return kind === null
        ? Promise.resolve()
        : Promise.reject(new ApiProviderError('Deepgram', kind));
    },
  });
  const listener: StreamingSpeechListener = {
    opened: () => heard.push({ event: 'opened' }),
    interim: (result) => heard.push({ event: 'interim', result }),
    final: (result) => heard.push({ event: 'final', result }),
    closed: (error) => heard.push({ event: 'closed', error }),
  };
  const session = provider.open(
    {
      language: setup.language ?? 'es-US',
      sampleRate: RATE,
      cancel: setup.cancel ?? new CancelSource().signal,
    },
    listener,
  );
  await settle();
  const socket = () => {
    const first = sockets.sockets[0];
    if (first === undefined) throw new Error('no socket was opened');
    return first;
  };
  const closedWith = (): ApiProviderError | null | undefined => {
    const last = heard.at(-1);
    return last?.event === 'closed' ? last.error : undefined;
  };
  return { provider, sockets, socket, timer, heard, keyChecks, session, closedWith };
}

/** An open session. */
async function opened(setup: Setup = {}) {
  const made = await start(setup);
  made.socket().open();
  return made;
}

const results = (
  words: readonly (readonly [string, number, number])[],
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  type: 'Results',
  channel_index: [0, 1],
  start: 0,
  duration: 1,
  is_final: false,
  speech_final: false,
  from_finalize: false,
  channel: {
    alternatives: [
      {
        transcript: words.map(([text]) => text).join(' '),
        confidence: 0.99,
        words: words.map(([text, wordStart, wordEnd]) => ({
          word: text.toLowerCase().replace(/[.,]/g, ''),
          punctuated_word: text,
          start: wordStart,
          end: wordEnd,
          confidence: 0.9,
        })),
      },
    ],
  },
  metadata: { request_id: 'r' },
  ...extra,
});

describe('DeepgramLiveSpeechProvider: opening', () => {
  it('opens one socket to /listen over wss with the stream format and the Token header', async () => {
    const { sockets, socket, heard } = await start();
    expect(sockets.sockets).toHaveLength(1);
    const url = new URL(socket().url);
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      language: 'es',
    });
    expect(socket().headers).toEqual({ Authorization: `Token ${KEY}` });
    expect(socket().url).not.toContain(KEY);
    expect(socket().binaryType).toBe('arraybuffer');
    expect(heard).toEqual([]);
    socket().open();
    expect(heard).toEqual([{ event: 'opened' }]);
  });

  it('asks for the multilingual model with its endpointing when the language is auto', async () => {
    const { socket } = await start({ language: 'auto' });
    const query = new URL(socket().url).searchParams;
    expect(query.get('language')).toBe('multi');
    expect(query.get('endpointing')).toBe('100');
  });

  it('names the provider the engine reports in its own failures', async () => {
    expect((await start()).provider.displayName).toBe('Deepgram');
  });

  it.each([null, '', '  '])(
    'fails as KeyMissing without a key (%j), opening nothing',
    async (key) => {
      const { sockets, heard, keyChecks } = await start({ key });
      expect(sockets.sockets).toHaveLength(0);
      expect(keyChecks).toEqual([]);
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatchObject({ event: 'closed', error: { kind: 'KeyMissing' } });
    },
  );
});

describe('DeepgramLiveSpeechProvider: audio and KeepAlive', () => {
  it('sends float samples as 16-bit little-endian PCM binary frames', async () => {
    const { session, socket } = await opened();
    session.send(Float32Array.of(0, 0.5, -0.5, 1, -1, 2, Number.NaN));
    expect(socket().sentAudio).toHaveLength(1);
    const frame = socket().sentAudio[0] ?? new Uint8Array();
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const values = Array.from({ length: frame.byteLength / 2 }, (_, i) =>
      view.getInt16(i * 2, true),
    );
    expect(values).toEqual([0, 16384, -16384, 32767, -32768, 32767, 0]);
  });

  it('sends nothing before the socket is open', async () => {
    const { session, socket } = await start();
    session.send(Float32Array.of(0.1));
    expect(socket().sent).toEqual([]);
  });

  it('sends a KeepAlive every four seconds while open, whether or not audio flows', async () => {
    const { socket, timer, session } = await start();
    await timer.advance(DEEPGRAM_KEEP_ALIVE_MS * 2);
    expect(socket().sentTypes).toEqual([]);
    socket().open();
    await timer.advance(DEEPGRAM_KEEP_ALIVE_MS - 1);
    expect(socket().sentTypes).toEqual([]);
    await timer.advance(1);
    expect(socket().sentTypes).toEqual(['KeepAlive']);
    session.send(Float32Array.of(0.1));
    await timer.advance(DEEPGRAM_KEEP_ALIVE_MS * 2);
    expect(socket().sentTypes).toEqual(['KeepAlive', 'KeepAlive', 'KeepAlive']);
    expect(DEEPGRAM_KEEP_ALIVE_MS).toBe(4000);
  });

  it('stops the KeepAlive when the session finishes, closes or fails', async () => {
    const finishing = await opened();
    finishing.session.finish();
    await finishing.timer.advance(DEEPGRAM_KEEP_ALIVE_MS * 3);
    expect(finishing.socket().sentTypes).toEqual(['Finalize', 'CloseStream']);

    const closing = await opened();
    closing.session.close();
    await closing.timer.advance(DEEPGRAM_KEEP_ALIVE_MS * 3);
    expect(closing.socket().sentTypes).toEqual([]);

    const failing = await opened();
    failing.socket().serverClose(1006);
    await failing.timer.advance(DEEPGRAM_KEEP_ALIVE_MS * 3);
    expect(failing.socket().sentTypes).toEqual([]);
  });
});

describe('DeepgramLiveSpeechProvider: results', () => {
  it('reads an interim and a final with punctuated words and absolute times', async () => {
    const { socket, heard } = await opened();
    socket().message(results([['Hola', 0.08, 0.4]], { start: 0, duration: 0.5 }));
    socket().message(
      results(
        [
          ['Hola', 0.08, 0.4],
          ['a', 0.5, 0.6],
          ['todos.', 0.7, 1.4],
        ],
        { start: 0, duration: 1.5, is_final: true },
      ),
    );
    socket().message(results([['Hoy', 1.6, 1.9]], { start: 1.5, duration: 0.5 }));
    expect(heard.slice(1)).toEqual([
      {
        event: 'interim',
        result: {
          text: 'Hola',
          words: [{ text: 'Hola', startMs: 80, endMs: 400 }],
          processedMs: 500,
        },
      },
      {
        event: 'final',
        result: {
          text: 'Hola a todos.',
          words: [
            { text: 'Hola', startMs: 80, endMs: 400 },
            { text: 'a', startMs: 500, endMs: 600 },
            { text: 'todos.', startMs: 700, endMs: 1400 },
          ],
          processedMs: 1500,
        },
      },
      {
        event: 'interim',
        result: {
          text: 'Hoy',
          words: [{ text: 'Hoy', startMs: 1600, endMs: 1900 }],
          processedMs: 2000,
        },
      },
    ]);
  });

  it('passes on a result with no words, so silence counts as listened to', async () => {
    const { socket, heard } = await opened();
    socket().message(results([], { start: 2, duration: 1.5, is_final: true }));
    expect(heard.at(-1)).toEqual({
      event: 'final',
      result: { text: '', words: [], processedMs: 3500 },
    });
  });

  it('falls back to the bare word when there is no punctuated one', async () => {
    const { socket, heard } = await opened();
    socket().message({
      type: 'Results',
      start: 0,
      duration: 1,
      is_final: true,
      channel: { alternatives: [{ words: [{ word: 'hola', start: 0.1, end: 0.3 }] }] },
    });
    expect(heard.at(-1)).toEqual({
      event: 'final',
      result: {
        text: '',
        words: [{ text: 'hola', startMs: 100, endMs: 300 }],
        processedMs: 1000,
      },
    });
  });

  it.each([
    ['text that is not JSON', 'not json {'],
    ['a JSON value that is not an object', '[1,2,3]'],
    ['null', 'null'],
    ['an object without a type', { start: 0 }],
    ['an unknown message type', { type: 'Whatever', is_final: true }],
    ['a speech started notice', { type: 'SpeechStarted', timestamp: 1 }],
    ['an utterance end notice', { type: 'UtteranceEnd', last_word_end: 1 }],
    ['results without a channel', { type: 'Results', start: 0, duration: 1 }],
    ['results whose channel is not an object', { type: 'Results', channel: 'x' }],
    ['results without alternatives', { type: 'Results', channel: { alternatives: [] } }],
    [
      'results without a start',
      { type: 'Results', duration: 1, channel: { alternatives: [{ words: [] }] } },
    ],
    [
      'results with times that are not numbers',
      { type: 'Results', start: 'a', duration: null, channel: { alternatives: [{ words: [] }] } },
    ],
    ['metadata while still recording', { type: 'Metadata', duration: 3 }],
  ])('ignores %s', async (_name, message) => {
    const { socket, heard } = await opened();
    expect(() => {
      socket().message(message);
    }).not.toThrow();
    expect(heard).toEqual([{ event: 'opened' }]);
    expect(socket().closes).toEqual([]);
  });

  it('ignores a binary frame', async () => {
    const { socket, heard } = await opened();
    socket().binary(new ArrayBuffer(4));
    expect(heard).toEqual([{ event: 'opened' }]);
  });

  it('keeps going after a message it could not read', async () => {
    const { socket, heard } = await opened();
    socket().message('{"type":"Results","channel":{"alternatives":[{"words":[null,7,{}]}]}');
    socket().message(results([['Hola', 0, 0.4]], { is_final: true }));
    expect(heard).toHaveLength(2);
    expect(heard[1]?.event).toBe('final');
  });
});

describe('DeepgramLiveSpeechProvider: finishing', () => {
  it('sends Finalize then CloseStream and ends cleanly at the Metadata message', async () => {
    const { session, socket, heard, closedWith } = await opened();
    session.send(Float32Array.of(0.1, 0.2));
    session.finish();
    expect(socket().sentTypes).toEqual(['Finalize', 'CloseStream']);
    expect(closedWith()).toBeUndefined();

    socket().message(
      results([['Adiós.', 0.1, 0.5]], { is_final: true, from_finalize: true, duration: 0.6 }),
    );
    socket().message(results([], { is_final: true, start: 0.6, duration: 0 }));
    expect(closedWith()).toBeUndefined();
    socket().message({ type: 'Metadata', request_id: 'r', duration: 0.6, channels: 1 });
    expect(closedWith()).toBeNull();
    expect(heard.map((entry) => entry.event)).toEqual(['opened', 'final', 'final', 'closed']);
    expect(socket().closes).toHaveLength(1);

    // The close that follows is the end of a session already over.
    socket().serverClose(1000);
    expect(heard.filter((entry) => entry.event === 'closed')).toHaveLength(1);
  });

  it('ends cleanly at a normal close when no Metadata came', async () => {
    const { session, socket, closedWith } = await opened();
    session.finish();
    socket().serverClose(1000);
    expect(closedWith()).toBeNull();
  });

  it('sends no audio after finish', async () => {
    const { session, socket } = await opened();
    session.finish();
    session.send(Float32Array.of(0.1));
    expect(socket().sentAudio).toEqual([]);
  });

  it('fails when the connection drops while finishing', async () => {
    const { session, socket, closedWith } = await opened();
    session.finish();
    socket().serverClose(1006);
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });

  it('finishes only once', async () => {
    const { session, socket } = await opened();
    session.finish();
    session.finish();
    expect(socket().sentTypes).toEqual(['Finalize', 'CloseStream']);
  });
});

describe('DeepgramLiveSpeechProvider: a session that never opens', () => {
  it('reads a refused connection as KeyInvalid when the provider refuses the key', async () => {
    const { socket, heard, keyChecks, closedWith } = await start({ keyCheck: 'KeyInvalid' });
    socket().fail();
    socket().serverClose(1006);
    await settle();
    expect(keyChecks).toEqual([KEY]);
    expect(closedWith()).toMatchObject({ kind: 'KeyInvalid', displayName: 'Deepgram' });
    expect(heard).toHaveLength(1);
  });

  it('reads it as the network failure when the provider cannot be reached at all', async () => {
    const { socket, closedWith } = await start({ keyCheck: 'Network' });
    socket().fail();
    socket().serverClose(1006);
    await settle();
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });

  it('keeps the kind the key check gives: out of funds, timed out', async () => {
    const funds = await start({ keyCheck: 'QuotaExceeded' });
    funds.socket().serverClose(1006);
    await settle();
    expect(funds.closedWith()).toMatchObject({ kind: 'QuotaExceeded' });

    const slow = await start({ keyCheck: 'TimedOut' });
    slow.socket().serverClose(1006);
    await settle();
    expect(slow.closedWith()).toMatchObject({ kind: 'TimedOut' });
  });

  it('reads it as a connection failure when the key is accepted', async () => {
    const { socket, keyChecks, closedWith } = await start({ keyCheck: null });
    socket().serverClose(1006);
    await settle();
    expect(keyChecks).toEqual([KEY]);
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });

  it('does not ask about a key the provider already took when a later session cannot open', async () => {
    // The key check would refuse: it must not be what decides, nor be sent at all.
    const { provider, sockets, socket, keyChecks, closedWith } = await opened({
      keyCheck: 'KeyInvalid',
    });
    socket().serverClose(1006);
    expect(closedWith()).toMatchObject({ kind: 'Network' });

    const reopened: (ApiProviderError | null)[] = [];
    provider.open(
      { language: 'es-US', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => undefined,
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => reopened.push(error),
      },
    );
    await settle();
    sockets.sockets[1]?.fail();
    sockets.sockets[1]?.serverClose(1006);
    await settle();
    expect(sockets.sockets).toHaveLength(2);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ kind: 'Network', displayName: 'Deepgram' });
    expect(keyChecks).toEqual([]);
  });

  it('checks the key once when both the error and the close arrive', async () => {
    const { socket, keyChecks, heard } = await start({ keyCheck: 'KeyInvalid' });
    socket().fail();
    socket().fail();
    socket().serverClose(1006);
    socket().serverClose(1006);
    await settle();
    expect(keyChecks).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it('explains a socket that could not even be created the same way', async () => {
    const sockets = new ScriptedLiveSockets();
    sockets.createError = new Error(`cannot connect with ${KEY}`);
    const heard: (ApiProviderError | null)[] = [];
    const provider = new DeepgramLiveSpeechProvider({
      displayName: 'Deepgram',
      baseUrl: 'https://api.deepgram.com/v1',
      model: 'nova-3',
      apiKey: () => Promise.resolve(KEY),
      timer: new ManualSpeechTimer(),
      socket: sockets.factory,
      checkKey: () => Promise.resolve(),
    });
    provider.open(
      { language: 'es', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => undefined,
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => heard.push(error),
      },
    );
    await settle();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ kind: 'Network' });
    expect(heard[0]?.message).not.toContain(KEY);
  });

  it('fails as Unknown, without the key, when the key cannot be read', async () => {
    const sockets = new ScriptedLiveSockets();
    const heard: (ApiProviderError | null)[] = [];
    const provider = new DeepgramLiveSpeechProvider({
      displayName: 'Deepgram',
      baseUrl: 'https://api.deepgram.com/v1',
      model: 'nova-3',
      apiKey: () => Promise.reject(new Error(`store broke near ${KEY}`)),
      timer: new ManualSpeechTimer(),
      socket: sockets.factory,
      checkKey: () => Promise.resolve(),
    });
    provider.open(
      { language: 'es', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => undefined,
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => heard.push(error),
      },
    );
    await settle();
    expect(sockets.sockets).toHaveLength(0);
    expect(heard[0]).toMatchObject({ kind: 'Unknown' });
    expect(heard[0]?.message).not.toContain(KEY);
  });
});

describe('DeepgramLiveSpeechProvider: a session that fails after opening', () => {
  it.each([
    [1006, '', 'Network'],
    [1001, 'going away', 'Network'],
    [1000, '', 'Network'],
    [1011, 'NET-0001', 'TimedOut'],
    [1011, '', 'TimedOut'],
    [1008, 'DATA-0000', 'Unknown'],
  ])('reads close code %i (%j) as %s', async (code, reason, kind) => {
    const { socket, heard, keyChecks } = await opened();
    socket().serverClose(code, reason);
    await settle();
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ event: 'closed', error: { kind, displayName: 'Deepgram' } });
    // The key is only checked for a session that never opened.
    expect(keyChecks).toEqual([]);
  });

  it.each([
    [{ type: 'Error', err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }, 'KeyInvalid'],
    [{ type: 'Error', err_code: 'ASR_PAYMENT_REQUIRED', err_msg: 'No funds.' }, 'QuotaExceeded'],
    [{ type: 'Error', err_code: 'TOO_MANY_REQUESTS' }, 'RateLimited'],
    [{ type: 'Error', variant: 'NET-0001', description: 'No audio.' }, 'TimedOut'],
    [{ type: 'Error', description: 'Something broke.' }, 'Unknown'],
    [{ type: 'Error' }, 'Unknown'],
  ])('ends the session at an Error message %j as %s', async (message, kind) => {
    const { socket, heard } = await opened();
    socket().message(message);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ event: 'closed', error: { kind } });
    expect(socket().closes).toHaveLength(1);
    // The close that follows says nothing new.
    socket().serverClose(1011);
    expect(heard).toHaveLength(2);
  });

  it('never puts the key in the text of a failure', async () => {
    const byMessage = await opened();
    byMessage.socket().message({ type: 'Error', description: `bad token ${KEY} given` });
    const fromMessage = byMessage.closedWith();
    expect(fromMessage?.kind).toBe('Unknown');
    expect(fromMessage?.detail).toContain('[redacted]');
    expect(`${fromMessage?.message ?? ''} ${fromMessage?.detail ?? ''}`).not.toContain(KEY);

    const byClose = await opened();
    byClose.socket().serverClose(1008, `DATA-0000 ${KEY}`);
    const fromClose = byClose.closedWith();
    expect(fromClose?.kind).toBe('Unknown');
    expect(`${fromClose?.message ?? ''} ${fromClose?.detail ?? ''}`).not.toContain(KEY);
  });

  it('fails as Network when the socket refuses a frame', async () => {
    const { session, socket, closedWith } = await opened();
    socket().sendError = new Error('not open');
    expect(() => {
      session.send(Float32Array.of(0.1));
    }).not.toThrow();
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });
});

describe('DeepgramLiveSpeechProvider: close and cancel', () => {
  it('closes the socket and tells the listener nothing more', async () => {
    const { session, socket, heard } = await opened();
    session.close();
    expect(socket().closes).toHaveLength(1);
    socket().message(results([['tarde', 0, 0.4]], { is_final: true }));
    socket().serverClose(1006);
    session.send(Float32Array.of(0.1));
    session.finish();
    await settle();
    expect(heard).toEqual([{ event: 'opened' }]);
    expect(socket().sent).toEqual([]);
  });

  it('ends at once when the pass is cancelled', async () => {
    const cancel = new CancelSource();
    const { socket, heard, keyChecks } = await opened({ cancel: cancel.signal });
    cancel.cancel();
    expect(socket().closes).toHaveLength(1);
    socket().serverClose(1006);
    await settle();
    expect(heard).toEqual([{ event: 'opened' }]);
    expect(keyChecks).toEqual([]);
  });

  it('opens no socket for a session closed while the key was being read', async () => {
    const sockets = new ScriptedLiveSockets();
    const heard: unknown[] = [];
    const provider = new DeepgramLiveSpeechProvider({
      displayName: 'Deepgram',
      baseUrl: 'https://api.deepgram.com/v1',
      model: 'nova-3',
      apiKey: () => Promise.resolve(KEY),
      timer: new ManualSpeechTimer(),
      socket: sockets.factory,
      checkKey: () => Promise.resolve(),
    });
    const session = provider.open(
      { language: 'es', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => heard.push('opened'),
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => heard.push(error),
      },
    );
    session.close();
    await settle();
    expect(sockets.sockets).toHaveLength(0);
    expect(heard).toEqual([]);
  });

  it('opens no socket for a pass that was already cancelled', async () => {
    const cancel = new CancelSource();
    cancel.cancel();
    const { sockets, heard } = await start({ cancel: cancel.signal });
    expect(sockets.sockets).toHaveLength(0);
    expect(heard).toEqual([]);
  });

  it('closes a socket that opens after the session was closed', async () => {
    const { session, socket, heard } = await start();
    session.close();
    socket().open();
    expect(heard).toEqual([]);
    expect(socket().closes.length).toBeGreaterThan(0);
  });

  it('says nothing when a session closed before opening loses its socket', async () => {
    const { session, socket, heard, keyChecks } = await start({ keyCheck: 'KeyInvalid' });
    session.close();
    socket().serverClose(1006);
    await settle();
    expect(heard).toEqual([]);
    expect(keyChecks).toEqual([]);
  });
});
