import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapturePort, AudioFrame, CaptureSession, TextInjectorPort } from '@vozella/core';
import { FakeAudioCapture } from '../fakes/fake-audio-capture';
import { FakeTextInjector } from '../fakes/fake-text-injector';
import { loadNativeAddon, type NativeAddon, type NativeFrame } from './addon';
import { createNativePorts } from './create-native-ports';
import { NativeAudioCapture, NativeTextInjector } from './native-adapters';

/** A stand-in addon with the same surface as the Rust one. */
function stubAddon(overrides: Partial<NativeAddon> = {}): NativeAddon {
  return {
    platformSupported: () => true,
    listMicrophones: () => [{ id: 'mic-1', name: 'Mic one' }],
    SessionMonitor: class {
      enumerate = () => [];
      readPeaks = () => [];
      dispose = () => undefined;
    },
    getProcessDetails: () => null,
    getVersionDetails: () => null,
    windowsBuild: () => 26_300,
    openAudioDecoder: () => ({ read: () => null, close: () => undefined }),
    startCapture: (_options, onFrame) => {
      const frame: NativeFrame = { pcm: new Uint8Array(640), tsMs: 0, synthesized: false };
      queueMicrotask(() => onFrame(null, frame));
      return {
        stop: () => ({
          frames: 1,
          realSamples: 320,
          synthesizedSamples: 0,
          packets: 1,
          silentFlagPackets: 0,
          discontinuities: 0,
        }),
      };
    },
    listTopLevelWindows: () => Promise.resolve([]),
    assignToKillOnCloseJob: () => undefined,
    foregroundTarget: () => ({
      windowHandle: 1001,
      focusHandle: 1002,
      processId: 4242,
      processName: 'notepad.exe',
      isOwnProcess: false,
      menuOpen: false,
      modifiersHeld: false,
      blocked: false,
    }),
    typeText: (text) => ({ sent: text.length * 2, expected: text.length * 2 }),
    ...overrides,
  };
}

/** A stub addon that records what it was asked to type, as the OS would receive it. */
function recordingAddon(): { addon: NativeAddon; typed: string[] } {
  const typed: string[] = [];
  const addon = stubAddon({
    typeText: (text) => {
      if (text !== '') typed.push(text);
      return { sent: text.length * 2, expected: text.length * 2 };
    },
  });
  return { addon, typed };
}

/** The same assertions run against the fake and the native adapter. */
function textInjectorContract(
  name: string,
  make: () => { injector: TextInjectorPort; typed: () => readonly string[] },
) {
  describe(`TextInjectorPort contract: ${name}`, () => {
    it('types the text and reports every event sent', () => {
      const { injector, typed } = make();
      const result = injector.typeText('qué tal');
      expect(typed()).toEqual(['qué tal']);
      expect(result.expected).toBeGreaterThan(0);
      expect(result.sent).toBe(result.expected);
    });

    it('sends nothing for an empty string', () => {
      const { injector, typed } = make();
      expect(injector.typeText('')).toEqual({ sent: 0, expected: 0 });
      expect(typed()).toEqual([]);
    });

    it('describes the foreground target', () => {
      const target = make().injector.foregroundTarget();
      expect(target).toEqual({
        windowHandle: expect.any(Number) as number,
        focusHandle: expect.any(Number) as number,
        processId: expect.any(Number) as number,
        processName: expect.any(String) as string,
        isOwnProcess: false,
        menuOpen: false,
        modifiersHeld: false,
        blocked: false,
      });
    });
  });
}

textInjectorContract('fake', () => {
  const injector = new FakeTextInjector();
  return { injector, typed: () => injector.typed };
});
textInjectorContract('native adapter over a stub addon', () => {
  const { addon, typed } = recordingAddon();
  return { injector: new NativeTextInjector(addon), typed: () => typed };
});

describe('NativeTextInjector', () => {
  it('maps fields napi leaves out to null', () => {
    const addon = stubAddon({
      foregroundTarget: () => ({
        windowHandle: 7,
        processId: 9,
        isOwnProcess: true,
        menuOpen: true,
        modifiersHeld: true,
        blocked: true,
      }),
    });
    expect(new NativeTextInjector(addon).foregroundTarget()).toEqual({
      windowHandle: 7,
      focusHandle: null,
      processId: 9,
      processName: null,
      isOwnProcess: true,
      menuOpen: true,
      modifiersHeld: true,
      blocked: true,
    });
  });

  it('answers null when there is no foreground window', () => {
    const addon = stubAddon({ foregroundTarget: () => null });
    expect(new NativeTextInjector(addon).foregroundTarget()).toBeNull();
  });

  it('reports a short count from the addon unchanged', () => {
    const addon = stubAddon({ typeText: () => ({ sent: 0, expected: 4 }) });
    expect(new NativeTextInjector(addon).typeText('hi')).toEqual({ sent: 0, expected: 4 });
  });
});

/** The same assertions run against the fake and the native adapter. */
function audioContract(name: string, make: () => AudioCapturePort) {
  describe(`AudioCapturePort contract: ${name}`, () => {
    let session: CaptureSession | undefined;

    afterEach(() => {
      session?.stop();
      vi.useRealTimers();
    });

    it('delivers 20 ms PCM16 frames and stats on stop', async () => {
      const frames: AudioFrame[] = [];
      session = await make().start({ kind: 'mic' }, (f) => frames.push(f));
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 1000 });
      expect(frames[0]?.pcm.byteLength).toBe(640);
      const stats = session.stop();
      expect(stats.frames).toBeGreaterThan(0);
      session = undefined;
    });
  });
}

audioContract('fake', () => new FakeAudioCapture());
audioContract('native adapter over a stub addon', () => new NativeAudioCapture(stubAddon()));

describe('NativeAudioCapture', () => {
  it('rejects when the device cannot be opened', async () => {
    const addon = stubAddon({
      startCapture: () => {
        throw new Error('no device');
      },
    });
    await expect(
      new NativeAudioCapture(addon).start({ kind: 'system' }, () => undefined),
    ).rejects.toThrow('no device');
  });

  it('passes the process source options through', async () => {
    const startCapture = vi.fn<NativeAddon['startCapture']>(() => ({
      stop: () => ({
        frames: 0,
        realSamples: 0,
        synthesizedSamples: 0,
        packets: 0,
        silentFlagPackets: 0,
        discontinuities: 0,
      }),
    }));
    await new NativeAudioCapture(stubAddon({ startCapture })).start(
      { kind: 'process', pid: 42, includeTree: false },
      () => undefined,
    );
    expect(startCapture.mock.calls[0]?.[0]).toEqual({
      kind: 'process',
      pid: 42,
      includeTree: false,
    });
  });
});

describe('FakeAudioCapture', () => {
  it('can be told to fail', async () => {
    await expect(
      new FakeAudioCapture({ failWith: 'denied' }).start({ kind: 'mic' }, () => undefined),
    ).rejects.toThrow('denied');
  });
});

describe('createNativePorts', () => {
  it('builds fakes without touching the filesystem', () => {
    const ports = createNativePorts({ fake: true });
    expect(ports.backend).toBe('fake');
    expect(ports.textInjector).toBeInstanceOf(FakeTextInjector);
  });

  it('wires the text injector to the addon', () => {
    const ports = createNativePorts({ fake: false, addonPath: 'x.node', load: () => stubAddon() });
    expect(ports.textInjector).toBeInstanceOf(NativeTextInjector);
  });

  it('rejects an addon without the text input exports', () => {
    const older: Partial<NativeAddon> = { ...stubAddon() };
    delete older.foregroundTarget;
    delete older.typeText;
    expect(() => loadNativeAddon('x.node', () => older)).toThrow(/expected API/);
  });

  it('builds native adapters from an addon loaded by path', async () => {
    const load = vi.fn(() => stubAddon());
    const ports = createNativePorts({ fake: false, addonPath: 'x.node', load });
    expect(load).toHaveBeenCalledWith('x.node');
    expect(ports.backend).toBe('native');
  });

  it('rejects an addon with the wrong shape', () => {
    expect(() => loadNativeAddon('x.node', () => ({}))).toThrow(/expected API/);
  });
});
