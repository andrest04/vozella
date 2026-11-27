import type {
  AudioCapturePort,
  AudioFileDecoder,
  AudioSessionSource,
  MicrophoneDeviceSource,
  OsBuildProbe,
  ProcessInfoProvider,
  TextInjectorPort,
  WindowScanPort,
} from '@vozella/core';
import { openWavFileDecoder } from '../audio/wav-file-decoder';
import { FakeAudioCapture } from '../fakes/fake-audio-capture';
import {
  FakeAudioSessionSource,
  FakeMicrophoneDevices,
  FakeOsBuild,
  FakeProcessInfo,
} from '../fakes/fake-audio-devices';
import type { ProcessJobPort } from '../llama/process-guard';
import { FakeTextInjector } from '../fakes/fake-text-injector';
import { FakeWindowLister } from '../fakes/fake-window-scanner';
import { loadNativeAddon } from './addon';
import {
  NativeAudioCapture,
  NativeAudioSessionSource,
  NativeMicrophoneDevices,
  NativeOsBuild,
  NativeProcessJob,
  NativeProcessInfo,
  NativeTextInjector,
  NativeWindowLister,
  openNativeDecoder,
} from './native-adapters';
import { WindowScanner } from './window-scanner';

export interface NativePorts {
  readonly backend: 'native' | 'fake';
  readonly platformSupported: boolean;
  readonly audio: AudioCapturePort;
  readonly microphones: MicrophoneDeviceSource;
  readonly sessions: AudioSessionSource;
  readonly processes: ProcessInfoProvider;
  readonly osBuild: OsBuildProbe;
  /** Opens an audio file as 16 kHz mono PCM16. Throws when it cannot be decoded. */
  readonly openDecoder: (path: string) => AudioFileDecoder;
  /** Kill-on-close job for child processes. Undefined when the build has no real one. */
  readonly processJob: ProcessJobPort | undefined;
  /** Is any open window a meeting call. A failed scan answers false. */
  readonly windowScan: WindowScanPort;
  /** Types text into the focused field of another app. */
  readonly textInjector: TextInjectorPort;
}

export type NativePortsOptions =
  | { readonly fake: true }
  | {
      readonly fake: false;
      readonly addonPath: string;
      readonly load: (path: string) => unknown;
      readonly onError?: (error: Error) => void;
    };

/** One switch between the real addon and the fakes. VOZELLA_FAKE_NATIVE=1 selects fakes. */
export function createNativePorts(options: NativePortsOptions): NativePorts {
  if (options.fake) {
    return {
      backend: 'fake',
      platformSupported: true,
      audio: new FakeAudioCapture({
        endWithErrorAfterMs: Number(process.env.VOZELLA_FAKE_CAPTURE_LOST_MS) || 0,
      }),
      microphones: new FakeMicrophoneDevices(),
      sessions: new FakeAudioSessionSource(),
      processes: new FakeProcessInfo(),
      osBuild: new FakeOsBuild(),
      openDecoder: openWavFileDecoder,
      processJob: undefined,
      windowScan: new WindowScanner(new FakeWindowLister()),
      textInjector: new FakeTextInjector(),
    };
  }
  const addon = loadNativeAddon(options.addonPath, options.load);
  return {
    backend: 'native',
    platformSupported: addon.platformSupported(),
    audio: new NativeAudioCapture(addon, options.onError),
    microphones: new NativeMicrophoneDevices(addon),
    sessions: new NativeAudioSessionSource(addon),
    processes: new NativeProcessInfo(addon),
    osBuild: new NativeOsBuild(addon),
    openDecoder: (path) => openNativeDecoder(addon, path),
    processJob: addon.platformSupported() ? new NativeProcessJob(addon) : undefined,
    windowScan: new WindowScanner(new NativeWindowLister(addon), options.onError),
    textInjector: new NativeTextInjector(addon),
  };
}
