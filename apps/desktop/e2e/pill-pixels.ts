import type { ElectronApplication } from '@playwright/test';
import { pixels } from './os/os';

// Pixel reads for the pill specs. On a visible run they come from the composed screen over the
// magenta backdrop (os.ps1). With VOZELLA_E2E_BACKGROUND=1 every window is parked off-screen, so
// the screen shows something else entirely: the pill is read from its own webContents.capturePage
// and composited over the same magenta backdrop, which keeps the same assertions meaningful.

/** True when the run keeps every window off-screen (VOZELLA_E2E_BACKGROUND=1). */
export const BACKGROUND = process.env.VOZELLA_E2E_BACKGROUND === '1';

export const BACKDROP = [255, 0, 255] as const;

export interface PillCapture {
  /** Bitmap size in physical pixels. */
  width: number;
  height: number;
  /** BGRA, 4 bytes per pixel, rows top to bottom. */
  data: Buffer;
}

export interface Point {
  x: number;
  y: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pill's own pixels as the page composed them, alpha included. */
export async function capturePill(app: ElectronApplication): Promise<PillCapture> {
  const raw = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().endsWith('/pill.html'),
    );
    if (!w) return null;
    const image = await w.webContents.capturePage();
    const size = image.getSize();
    return { ...size, data: image.toBitmap().toString('base64') };
  });
  if (!raw) throw new Error('the pill window does not exist');
  return { width: raw.width, height: raw.height, data: Buffer.from(raw.data, 'base64') };
}

/**
 * The colour at a point of the capture, over the magenta backdrop. `at` is in physical pixels
 * from the window's top left corner. The bitmap is premultiplied, so a transparent pixel is
 * zero and adds the whole backdrop.
 */
export function captureRgb(capture: PillCapture, at: Point): number[] {
  const x = Math.min(capture.width - 1, Math.max(0, Math.round(at.x)));
  const y = Math.min(capture.height - 1, Math.max(0, Math.round(at.y)));
  const i = (y * capture.width + x) * 4;
  const b = capture.data[i] ?? 0;
  const g = capture.data[i + 1] ?? 0;
  const r = capture.data[i + 2] ?? 0;
  const a = (capture.data[i + 3] ?? 0) / 255;
  return [r, g, b].map((c, k) => Math.round(c + (1 - a) * (BACKDROP[k] ?? 0)));
}

/** The capture's pixels per DIP, read from the capture itself so DPI rounding cannot drift. */
export const captureScale = (capture: PillCapture, bounds: WindowRect): number =>
  capture.width / bounds.width;

/**
 * Colours at screen DIP points, the same signature the specs used with the screen reader. On a
 * visible run it asks `screenPixels` (physical screen points); in background it reads the pill's
 * capture, so every point must lie inside `bounds`, the pill window in screen DIP.
 */
export async function pillPixelsAt(
  app: ElectronApplication,
  bounds: WindowRect,
  points: Point[],
  screenPixels: (physicalPoints: Point[]) => Promise<Point[]>,
): Promise<number[][]> {
  if (!BACKGROUND) return pixels(await screenPixels(points));
  const capture = await capturePill(app);
  const scale = captureScale(capture, bounds);
  return points.map((p) =>
    captureRgb(capture, { x: (p.x - bounds.x) * scale, y: (p.y - bounds.y) * scale }),
  );
}
