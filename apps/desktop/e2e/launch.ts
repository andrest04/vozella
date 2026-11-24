import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly dataRoot: string;
  close(): Promise<void>;
}

const desktopDir = path.resolve(__dirname, '..');

/** VOZELLA_E2E_BACKGROUND=1 keeps every window off-screen, so a run does not disturb the desktop. */
function builtAppArgs(): string[] {
  const main = path.join(desktopDir, 'out', 'main', 'index.js');
  return process.env.VOZELLA_E2E_BACKGROUND === '1'
    ? ['-r', path.join(desktopDir, 'e2e', 'background-windows.cjs'), main]
    : [main];
}

/**
 * Launches the built app (out/main/index.js, run `pnpm build` first), or the packaged e2e
 * variant when VOZELLA_E2E_EXECUTABLE is set, with fake native
 * adapters and a throwaway data root. The real data folders are never involved.
 */
export async function launchApp(
  extraEnv: Record<string, string> = {},
  /** Runs before the app starts, to put files in the throwaway data root. */
  seed?: (dataRoot: string) => void,
): Promise<LaunchedApp> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-e2e-'));
  seed?.(dataRoot);
  // VOZELLA_E2E_EXECUTABLE points at a packaged e2e-variant build (pnpm package:e2e).
  const executablePath = process.env.VOZELLA_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: builtAppArgs() }),
    cwd: desktopDir,
    env: {
      ...process.env,
      VOZELLA_E2E: '1',
      VOZELLA_FAKE_NATIVE: '1',
      VOZELLA_DATA_ROOT: dataRoot,
      ...extraEnv,
    },
  });
  return {
    app,
    dataRoot,
    close: async () => {
      await app.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Like `launchApp`, but on a data root the caller owns: closing the app leaves the folder, so a
 * second launch can read what the first one wrote (window state, single instance).
 */
export async function launchAppInRoot(
  dataRoot: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  const executablePath = process.env.VOZELLA_E2E_EXECUTABLE;
  return electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: builtAppArgs() }),
    cwd: desktopDir,
    env: {
      ...process.env,
      VOZELLA_E2E: '1',
      VOZELLA_FAKE_NATIVE: '1',
      VOZELLA_DATA_ROOT: dataRoot,
      ...extraEnv,
    },
  });
}

/** A summary model that counts as downloaded on the fake build, so only the engine is missing. */
export const READY_MODEL = 'Llama-3.2-1B-Instruct-Q4_K_M.gguf';

/** Environment for a Record page that passes the setup gate once `installEngine` has run. */
export const readyEnv: Record<string, string> = {
  VOZELLA_FAKE_ENGINE_STEP_MS: '5',
  VOZELLA_FAKE_MODEL_PRESENT: READY_MODEL,
};

/** Seeds the local summary provider; use with `readyEnv`. */
export function seedReadySettings(root: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', 'settings.json'),
    JSON.stringify({ selectedSummaryProvider: 'Local', selectedSummaryModelId: READY_MODEL }),
  );
}

/**
 * The saved settings of a data root, or an empty object while there are none. A fresh data root has
 * no settings.json until the app saves its first change, a moment after the click that asks for it,
 * and `expect.poll` (like `toPass`) does not retry a read that throws: a missing file must read as
 * "not saved yet" so the poll waits for the save. Only a missing file is tolerated; any other error
 * is rethrown. The store writes atomically (a temp file, then a rename), so a file that exists is
 * whole and always parses.
 */
export function readSettings(root: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'app', 'settings.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Puts the fake engine on disk, the last thing the Record setup gate waits for, and reloads so the
 * Record page reads the setup again (it reads it on entry, and the window opens on Record).
 */
export async function installEngine(page: Page): Promise<void> {
  await page.evaluate(() => window.vozella.invoke('transcription.ensureEngine', {}));
  await page.reload();
  await page.getByRole('navigation').waitFor();
}

/** True when the run drives a packaged build (pnpm test:e2e:packaged). */
export const packaged = Boolean(process.env.VOZELLA_E2E_EXECUTABLE);

/** Why a spec cannot run against a packaged build, which is production mode. */
export const NO_GALLERY = 'the component gallery route does not exist in a packaged build';
export const NO_TEST_HOOKS =
  'a packaged build is production mode, which ignores the test-only hooks';

/**
 * Screenshots of the packaged app, taken only when the run targets a packaged build
 * (VOZELLA_E2E_EXECUTABLE) and VOZELLA_PACKAGED_SHOTS=1. They go to docs/screenshots/packaged.
 */
export const packagedShots =
  process.env.VOZELLA_PACKAGED_SHOTS === '1' && Boolean(process.env.VOZELLA_E2E_EXECUTABLE);

/** A function `evaluateMain` runs in the main process on the main window. */
export type MainWindowFunction<R, Arg> = (
  main: Electron.BrowserWindow,
  arg: Arg,
  electron: typeof Electron.CrossProcessExports,
) => R | Promise<R>;

/**
 * Runs `fn` in the main process on the main window, the one showing /index.html.
 *
 * The app has more windows than the main one: the live copilot pill (/pill.html) and the meeting
 * popup (/meeting-prompt.html) are created on demand, then hidden, never destroyed.
 * `getAllWindows()` does not list them in creation order, and all three pages are titled
 * "Vozella", so neither the first window nor the title finds the main one. Its page path does:
 * the app routes by hash, so the path stays /index.html on every screen.
 *
 * Like any `app.evaluate` callback, `fn` is sent as source text, so it can use only its own
 * parameters: the main window, `arg`, and the electron module.
 */
export async function evaluateMain<R, Arg = undefined>(
  app: ElectronApplication,
  fn: MainWindowFunction<R, Arg>,
  arg?: Arg,
): Promise<R> {
  return (await app.evaluate(
    async (electron, payload) => {
      const { source, value } = payload as unknown as { source: string; value: Arg };
      const isMain = (w: Electron.BrowserWindow): boolean => {
        if (w.isDestroyed()) return false;
        const url = w.webContents.getURL();
        return URL.canParse(url) && new URL(url).pathname === '/index.html';
      };
      const all = electron.BrowserWindow.getAllWindows();
      const main = all.find(isMain);
      if (!main) {
        const urls = all.map((w) => (w.isDestroyed() ? '(destroyed)' : w.webContents.getURL()));
        throw new Error(`no main window (/index.html) among: ${urls.join(', ') || 'no windows'}`);
      }
      // The callback arrives as source text, the way Playwright sends any evaluate callback.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const revive = new Function(`return (${source});`) as () => MainWindowFunction<unknown, Arg>;
      return revive()(main, value, electron);
    },
    { source: fn.toString(), value: arg },
  )) as R;
}

/** Sets the size of the main window's content area. */
export async function setMainContentSize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await evaluateMain(
    app,
    (main, size) => {
      main.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

/**
 * Starting a take minimizes the main window (the live copilot pill takes over) and a minimized
 * window paints nothing, so a screenshot taken during or after a take needs this first. It does
 * what the pill's Show button does.
 */
export async function restoreMain(app: ElectronApplication): Promise<void> {
  await evaluateMain(app, (main) => {
    if (main.isMinimized()) main.restore();
    main.show();
  });
}

export async function packagedShot(
  page: Page,
  name: string,
  app?: ElectronApplication,
): Promise<void> {
  if (!packagedShots) return;
  if (app) await restoreMain(app);
  const dir = path.resolve(__dirname, '../../../docs/screenshots/packaged');
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, name) });
}

/** The tabs of the Settings page, by the id in their automation id (`SettingsTab-<id>`). */
export type SettingsTab = 'recording' | 'transcription' | 'summary' | 'general';

/**
 * Shows one tab of the Settings page, which must be on screen. The page opens on Recording and,
 * within one window, on the tab it was left on, so a spec that needs a section names its tab.
 */
export async function openSettingsTab(page: Page, id: SettingsTab): Promise<void> {
  const tab = page.getByTestId(`SettingsTab-${id}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  // The panel that was on screen leaves on the next frame, and a hidden test window can take
  // seconds to draw one; wait until only the chosen panel is left.
  await expect(page.getByRole('tabpanel')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('tabpanel')).toBeVisible();
}
