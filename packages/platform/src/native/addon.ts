/**
 * Hand-written type of the vozella-native addon. It mirrors native/vozella-native/src;
 * the contract tests in this package keep the fake and the real adapter in step.
 */
export interface NativeFrame {
  pcm: Uint8Array;
  tsMs: number;
  synthesized: boolean;
}

export interface NativeCaptureStats {
  frames: number;
  realSamples: number;
  synthesizedSamples: number;
  packets: number;
  silentFlagPackets: number;
  discontinuities: number;
}

export interface NativeProcessDetails {
  processId: number;
  parentProcessId: number;
  exePath?: string | null;
  processName: string;
  startTimeUtcMs?: number | null;
}

export interface NativeSessionSnapshot {
  processId: number;
  isSystemSounds: boolean;
  isStateActive: boolean;
  peak: number;
}

export interface NativeSessionMonitor {
  enumerate(): NativeSessionSnapshot[];
  readPeaks(): NativeSessionSnapshot[];
  dispose(): void;
}

export interface NativeAudioDecoder {
  /** 16 kHz mono PCM16 little-endian, or null at the end of the file. */
  read(): Uint8Array | null;
  close(): void;
}

/** napi leaves a `None` field out of the object, so optional fields may be missing. */
export interface NativeForegroundTarget {
  windowHandle: number;
  focusHandle?: number | null;
  processId: number;
  processName?: string | null;
  isOwnProcess: boolean;
  menuOpen: boolean;
  modifiersHeld: boolean;
  blocked: boolean;
}

export interface NativeTypeTextResult {
  sent: number;
  expected: number;
}

export interface NativeAddon {
  platformSupported(): boolean;
  startCapture(
    options: { kind: string; deviceId?: string | null; pid?: number; includeTree?: boolean },
    onFrame: (error: Error | null, frame: NativeFrame) => void,
    onStopped: (error: Error | null, info: { error?: string | null }) => void,
  ): { stop(): NativeCaptureStats };
  listMicrophones(): { id: string; name: string }[];
  SessionMonitor: new () => NativeSessionMonitor;
  getProcessDetails(pid: number): NativeProcessDetails | null;
  getVersionDetails(path: string): {
    fileDescription?: string | null;
    productName?: string | null;
  } | null;
  windowsBuild(): number;
  openAudioDecoder(path: string): NativeAudioDecoder;
  listTopLevelWindows(): Promise<{ processName: string; title: string }[]>;
  /** Puts the process in a Job Object that kills it when this process dies. Throws on failure. */
  assignToKillOnCloseJob(pid: number): void;
  /** The window that would receive typed keys, or null when none is in the foreground. */
  foregroundTarget(): NativeForegroundTarget | null;
  /** Types the text with one SendInput call. Throws only off Windows. */
  typeText(text: string): NativeTypeTextResult;
}

/**
 * Loads the addon from an explicit path. `load` is the host's `require`; the platform
 * package never guesses where the .node file lives.
 */
export function loadNativeAddon(addonPath: string, load: (path: string) => unknown): NativeAddon {
  const addon = load(addonPath) as Partial<NativeAddon> | null;
  if (
    !addon ||
    typeof addon.platformSupported !== 'function' ||
    typeof addon.startCapture !== 'function' ||
    typeof addon.listMicrophones !== 'function' ||
    typeof addon.SessionMonitor !== 'function' ||
    typeof addon.getProcessDetails !== 'function' ||
    typeof addon.getVersionDetails !== 'function' ||
    typeof addon.windowsBuild !== 'function' ||
    typeof addon.openAudioDecoder !== 'function' ||
    typeof addon.listTopLevelWindows !== 'function' ||
    typeof addon.assignToKillOnCloseJob !== 'function' ||
    typeof addon.foregroundTarget !== 'function' ||
    typeof addon.typeText !== 'function'
  ) {
    throw new Error(`native addon at ${addonPath} does not expose the expected API`);
  }
  return addon as NativeAddon;
}
