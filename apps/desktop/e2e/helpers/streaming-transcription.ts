import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import axe from 'axe-core';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  launchApp,
  openSettingsTab,
  READY_MODEL,
  type LaunchedApp,
  setMainContentSize,
} from '../launch';

// What the specs of the streaming cloud engines (Deepgram, ElevenLabs) share. They run on the fake
// native build: the key store is in memory, the live session is the scripted one whatever engine
// asks for it, and the data root is the temp folder `launchApp` makes.

export type Settings = Record<string, unknown>;

/** A transcription-only provider whose live session streams. */
export type StreamingKind = 'Deepgram' | 'ElevenLabs';

/** The summary is ready, so the transcription engine is the only thing the Record gate can miss. */
const seed = (settings: Settings) => (root: string) => {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', 'settings.json'),
    JSON.stringify({
      selectedSummaryProvider: 'Local',
      selectedSummaryModelId: READY_MODEL,
      ...settings,
    }),
  );
};

export async function open(
  settings: Settings = {},
  env: Record<string, string> = {},
): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchApp(
    {
      VOZELLA_FAKE_MODEL_PRESENT: READY_MODEL,
      VOZELLA_FAKE_ENGINE_STEP_MS: '600',
      VOZELLA_E2E_SHOW: '0',
      ...env,
    },
    seed(settings),
  );
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await setMainContentSize(launched.app, 1180, 1000);
  return { launched, page };
}

export async function closeApp(launched: LaunchedApp, page: Page): Promise<void> {
  await page.evaluate(() => window.vozella.invoke('recording.discard', {})).catch(() => undefined);
  await launched.close();
}

export const settingsFile = (launched: LaunchedApp): Settings =>
  JSON.parse(
    fs.readFileSync(path.join(launched.dataRoot, 'app', 'settings.json'), 'utf8'),
  ) as Settings;

const go = (page: Page, name: RegExp): Promise<void> =>
  page.getByRole('navigation').getByRole('link', { name }).click();
/** Settings, on the tab that holds the Transcription section. */
export const toSettings = async (page: Page): Promise<void> => {
  await go(page, /^(Settings|Configuración)$/);
  await openSettingsTab(page, 'transcription');
};
export const toRecord = (page: Page): Promise<void> => go(page, /^(Record|Grabar)$/);

export const section = (page: Page): Locator => page.getByTestId('transcription-section');
export const choice = (page: Page): Locator =>
  section(page).getByRole('radiogroup', { name: 'Where meetings are transcribed' });
export const keyField = (page: Page): Locator =>
  section(page).getByLabel('API key', { exact: true }).and(page.locator('input'));

/** Saves a key the way a test that is not about the key field does: through the channel. */
export const saveKey = (page: Page, kind: StreamingKind, key: string): Promise<unknown> =>
  page.evaluate((arg) => window.vozella.invoke('transcription.setProviderKey', arg), { kind, key });

/** Every file under the data root whose name ends with `extension`. */
export function filesOf(launched: LaunchedApp, extension: string): string[] {
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          return entry.name.endsWith(extension) ? [full] : [];
        })
      : [];
  return walk(launched.dataRoot);
}

/** Every saved meeting Markdown in the data root. */
export const meetings = (launched: LaunchedApp): string[] =>
  filesOf(launched, '.md').map((file) => fs.readFileSync(file, 'utf8'));

export interface LiveUpdate {
  readonly displayText: string;
  readonly committedText: string;
}
type LiveWindow = Window & { liveUpdates?: LiveUpdate[] };

/** Keeps every live transcript update the window is sent, in order. */
export const recordLiveUpdates = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const target = window as LiveWindow;
    target.liveUpdates = [];
    window.vozella.on('transcription.liveUpdate', (update) => {
      target.liveUpdates?.push({
        displayText: update.displayText,
        committedText: update.committedText,
      });
    });
  });
export const liveUpdates = (page: Page): Promise<LiveUpdate[]> =>
  page.evaluate(() => (window as LiveWindow).liveUpdates ?? []);

/**
 * axe reads an element that is still fading in as hidden, and a hidden label fails its field. The
 * page fade and the panel fades are finite, so this waits for them (never for the recording pulse,
 * which loops) instead of sleeping.
 */
async function fadesDone(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getComputedTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
}

/** The serious and critical axe violations of the page, once its fades are done. */
export async function serious(page: Page): Promise<{ id: string; impact: string | null }[]> {
  await fadesDone(page);
  await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        axe: { run: () => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    const result = await api.run();
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  });
}

/** How the main process's socket ended, and the runtime it ran on. */
export interface MainSocketOutcome {
  readonly events: string[];
  readonly code: number | null;
  readonly node: string;
  readonly electron: string;
}

/**
 * Opens a WebSocket from Electron's main process, the way `globalLiveSocket` does in the app, to a
 * server on this PC that only records the upgrade request and drops the connection. Returns the
 * request headers that server saw and how the socket ended. Nothing leaves the machine.
 */
export async function mainProcessUpgrade(
  launched: LaunchedApp,
  pathAndQuery: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ upgrades: http.IncomingHttpHeaders[]; seen: MainSocketOutcome }> {
  const upgrades: http.IncomingHttpHeaders[] = [];
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    upgrades.push(request.headers);
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const seen = await launched.app.evaluate(
      (_electron, arg) =>
        new Promise<MainSocketOutcome>((resolve) => {
          type HeaderSocket = new (
            url: string,
            init: { headers: Record<string, string> },
          ) => {
            addEventListener(type: string, listener: (event: { code?: number }) => void): void;
          };
          const Socket = (globalThis as unknown as { WebSocket: HeaderSocket }).WebSocket;
          const events: string[] = [];
          const done = (code: number | null): void => {
            resolve({
              events,
              code,
              node: process.versions.node,
              electron: process.versions.electron,
            });
          };
          const socket = new Socket(arg.url, { headers: { ...arg.headers } });
          socket.addEventListener('error', () => events.push('error'));
          socket.addEventListener('close', (event) => {
            events.push('close');
            done(event.code ?? null);
          });
          setTimeout(() => {
            done(null);
          }, 15_000);
        }),
      { url: `ws://127.0.0.1:${String(port)}${pathAndQuery}`, headers: { ...headers } },
    );
    return { upgrades, seen };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
