/*
 * The socket of a live speech session as the adapters see it: the few members of the standard
 * `WebSocket` they use. Tests hand the adapters a scripted one; the app uses the runtime's own.
 */

/** What a socket event carries. `data` on a message; `code` and `reason` on a close. */
export interface LiveSocketEvent {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

export type LiveSocketEventType = 'open' | 'message' | 'error' | 'close';

export interface LiveSocket {
  /** Set to `arraybuffer` by the adapters, which read text frames only. */
  binaryType: string;
  /** A string goes out as a text frame, bytes as a binary frame. */
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number): void;
  addEventListener(type: LiveSocketEventType, listener: (event: LiveSocketEvent) => void): void;
}

/** Opens a socket to `url` with these request headers (the provider's key travels in one). */
export type LiveSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => LiveSocket;

type HeaderSocketConstructor = new (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => LiveSocket;

/**
 * The runtime's global `WebSocket` (Node 24, Electron's main process). Unlike a browser's it takes
 * request headers, which is how the key is sent; observed against Deepgram on 2026-11-15, so no
 * `ws` dependency is needed.
 */
export const globalLiveSocket: LiveSocketFactory = (url, headers) => {
  const Socket = (globalThis as unknown as { readonly WebSocket: HeaderSocketConstructor })
    .WebSocket;
  return new Socket(url, { headers });
};

/**
 * Float samples in -1..1 as 16-bit little-endian PCM, the raw form a live session is sent. The
 * same rounding as the app's WAV writer: samples outside the range are clamped, NaN is silence.
 */
export function float32ToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const scaled = Math.round((samples[i] ?? 0) * 32768);
    const value = Number.isNaN(scaled) ? 0 : Math.max(-32768, Math.min(32767, scaled));
    view.setInt16(i * 2, value, true);
  }
  return bytes;
}
