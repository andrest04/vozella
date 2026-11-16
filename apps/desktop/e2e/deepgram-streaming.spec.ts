import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, openSettingsTab, READY_MODEL, restoreMain, type LaunchedApp } from './launch';

// Streaming cloud transcription (Deepgram) with the user's own API key, in the real window on the
// fake native build: the key store is in memory, the live session is a scripted one that hears one
// word per half second of audio (interim results that grow, a final when the phrase ends) and can
// be made to refuse the key, and the upload client of the pass after Stop hears the same script.
// No request leaves the PC, no account and no real key is used, and the data root is a temp folder.

const KEY = 'dg-e2e-SECRET-0123456789';

test.describe.configure({ timeout: 150_000 });

type Settings = Record<string, unknown>;

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

async function open(
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
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 1000);
  });
  return { launched, page };
}

async function closeApp(launched: LaunchedApp, page: Page): Promise<void> {
  await page.evaluate(() => window.vozella.invoke('recording.discard', {})).catch(() => undefined);
  await launched.close();
}

const settingsFile = (launched: LaunchedApp): Settings =>
  JSON.parse(
    fs.readFileSync(path.join(launched.dataRoot, 'app', 'settings.json'), 'utf8'),
  ) as Settings;

const go = (page: Page, name: RegExp): Promise<void> =>
  page.getByRole('navigation').getByRole('link', { name }).click();
/** Settings, on the tab that holds the Transcription section. */
const toSettings = async (page: Page): Promise<void> => {
  await go(page, /^(Settings|Configuración)$/);
  await openSettingsTab(page, 'transcription');
};
const toRecord = (page: Page): Promise<void> => go(page, /^(Record|Grabar)$/);

const section = (page: Page): Locator => page.getByTestId('transcription-section');
const choice = (page: Page): Locator =>
  section(page).getByRole('radiogroup', { name: 'Where meetings are transcribed' });
const keyField = (page: Page): Locator =>
  section(page).getByLabel('API key', { exact: true }).and(page.locator('input'));

/** Saves the Deepgram key the way a test that is not about the key field does: through the channel. */
const saveKey = (page: Page): Promise<unknown> =>
  page.evaluate(
    (key) => window.vozella.invoke('transcription.setProviderKey', { kind: 'Deepgram', key }),
    KEY,
  );

/** Every file under the data root whose name ends with `extension`. */
function filesOf(launched: LaunchedApp, extension: string): string[] {
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
const meetings = (launched: LaunchedApp): string[] =>
  filesOf(launched, '.md').map((file) => fs.readFileSync(file, 'utf8'));

interface LiveUpdate {
  readonly displayText: string;
  readonly committedText: string;
}
type LiveWindow = Window & { liveUpdates?: LiveUpdate[] };

/** Keeps every live transcript update the window is sent, in order. */
const recordLiveUpdates = (page: Page): Promise<void> =>
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
const liveUpdates = (page: Page): Promise<LiveUpdate[]> =>
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

async function serious(page: Page): Promise<{ id: string; impact: string | null }[]> {
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

test('Deepgram with its key: the take streams word by word, and Stop keeps that transcript without a second pass', async () => {
  // The upload client refuses every request: a pass after Stop, if one ran, would fail in view.
  // The live session opens and answers 1.5 s behind the audio, as a real one is a little behind.
  const { launched, page } = await open(
    {},
    { VOZELLA_FAKE_STT_FAIL: 'KeyInvalid', VOZELLA_FAKE_STREAM_DELAY_MS: '1500' },
  );
  try {
    await toSettings(page);
    await choice(page)
      .getByRole('radio', { name: /^Deepgram/ })
      .click();
    await expect(choice(page).getByRole('radio', { name: /^Deepgram/ })).toBeChecked();
    await expect.poll(() => settingsFile(launched).transcriptionEngine).toBe('Deepgram');
    await expect(
      section(page).getByText(
        'While Deepgram is selected, the audio of each meeting is sent to Deepgram to be turned into text.',
      ),
    ).toBeVisible();

    // Without the key the Record gate asks for it, by the provider's name, and for nothing else.
    await toRecord(page);
    const gate = page.getByTestId('setup-checklist');
    await expect(
      gate.getByText('Add your Deepgram API key to record. Nothing needs to be downloaded.'),
    ).toBeVisible();
    await expect(gate.getByText('Deepgram needs your API key. Add it in Settings.')).toBeVisible();
    await expect(page.getByTestId('BtnRecord')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add API key' }).click();
    await expect(keyField(page)).toBeFocused();

    await keyField(page).fill(KEY);
    await section(page).getByRole('button', { name: 'Save key' }).click();
    await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
    await expect(keyField(page)).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    expect(JSON.stringify(settingsFile(launched))).not.toContain(KEY);
    const live = section(page).getByRole('switch', { name: 'Live transcription during recording' });
    await expect(live).toBeEnabled();
    await expect(live).toBeChecked();

    // With the key saved the gate is gone: nothing words it as a missing key any more.
    await toRecord(page);
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
    await recordLiveUpdates(page);
    await page.getByRole('textbox', { name: 'Title' }).fill('Stream take');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    const pane = page.getByRole('region', { name: 'Live transcript' });
    await expect(pane).toContainText('Captions appear here as people speak.');

    // The first words are on screen long before a 15 s piece could have been uploaded, and the
    // whole first phrase after it was said (8 words, 4 s of audio).
    await expect(pane).toContainText('Buenos días', { timeout: 20_000 });
    await expect(pane).toContainText('Buenos días a todos y gracias por venir.', {
      timeout: 30_000,
    });
    await expect(pane).toContainText('Hoy revisamos', { timeout: 30_000 });
    await expect(page.getByTestId('live-notice')).toHaveCount(0);

    const updates = await liveUpdates(page);
    // Interim results rewrite the line: while nothing is committed the text on screen grows.
    const interim = updates.filter((update) => update.committedText === '');
    const shown = [...new Set(interim.map((update) => update.displayText))];
    expect(shown.length).toBeGreaterThan(2);
    // Each rewrite is the same line with more words; only its end time and its text change.
    const words = shown.map((text) => text.slice(text.indexOf('] ') + 2));
    words.forEach((text, index) => {
      if (index > 0) expect(text.startsWith(`${words[index - 1] ?? ''} `)).toBe(true);
    });
    // The words waiting for the session to open arrive together; the phrase is not whole yet.
    expect(words[0]).toMatch(/^Buenos\b/);
    expect(words[0]).not.toContain('venir');
    // The final result commits the phrase, and the next one starts as interim text after it.
    const committed = updates.find((update) => update.committedText !== '');
    expect(committed?.committedText).toMatch(/\] Buenos días a todos y gracias por venir\.$/);
    expect(
      updates.some(
        (update) =>
          update.committedText !== '' &&
          update.displayText.length > update.committedText.length &&
          update.displayText.startsWith(update.committedText),
      ),
    ).toBe(true);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() => meetings(launched).find((text) => text.includes('Stream take')) ?? '', {
        timeout: 60_000,
      })
      .toMatch(
        /\[\d{2}:\d{2}\.\d{2}-\d{2}:\d{2}\.\d{2}\] Buenos días a todos y gracias por venir\./,
      );
    await restoreMain(launched.app);
    await expect(page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 60_000 });
    // No second pass ran: the upload client would have refused it, and the run would end saying
    // "Saved with the live transcript. The final transcription failed: ..." instead of this.
    await expect(page.getByText(/^Done\. Transcript (and summary )?available/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/transcription failed/i)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const status = await page.evaluate(() => window.vozella.invoke('transcription.getStatus', {}));
    expect(status).toMatchObject({
      engine: 'Deepgram',
      ready: true,
      cloudNotReadyReason: null,
      // The live session answered for every sample it was sent.
      liveDroppedPercent: 0,
      modelInstalled: false,
    });
  } finally {
    await closeApp(launched, page);
  }
});

test('a key Deepgram refuses: the live captions stop with the reason, the take records on, and the audio is kept and transcribed after Stop', async () => {
  const { launched, page } = await open(
    { transcriptionEngine: 'Deepgram' },
    { VOZELLA_FAKE_STREAM_FAIL: 'KeyInvalid' },
  );
  try {
    await saveKey(page);
    await toRecord(page);
    await page.getByRole('textbox', { name: 'Title' }).fill('Refused stream');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    const notice = page.getByTestId('live-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Live captions stopped');
    await expect(notice).toContainText(
      'Fake streaming speech did not accept your API key. Check it in Settings. The recording continues, and you can transcribe it after you stop.',
    );
    // Calm: a polite status, not an alert, and the take is still recording.
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await expect(page.getByTestId('recording-status')).toContainText('Recording...');
    await restoreMain(launched.app);
    expect(await serious(page)).toEqual([]);

    // Enough audio for the pass after Stop to hear the start of the script.
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.vozella.invoke('recording.getState', {}));
        return state.elapsedMs;
      })
      .toBeGreaterThan(3_000);
    await page.getByRole('button', { name: 'Stop' }).click();
    // The live pass lost the whole take, so the pass after Stop uploads the recording (the fake
    // upload client accepts it) and the meeting is saved with that transcript.
    await expect
      .poll(() => meetings(launched).find((text) => text.includes('Refused stream')) ?? '', {
        timeout: 60_000,
      })
      .toContain('Buenos días');
    await restoreMain(launched.app);
    await expect(page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 60_000 });
    await expect(notice).toHaveCount(0);
    // The audio is kept beside the meeting.
    const audio = filesOf(launched, '.wav');
    expect(audio.length).toBeGreaterThan(0);
    expect(fs.statSync(audio[0] ?? '').size).toBeGreaterThan(44);
  } finally {
    await closeApp(launched, page);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Transcription section with Deepgram selected has no serious violations in ${theme}`, async () => {
    const { launched, page } = await open({
      transcriptionEngine: 'Deepgram',
      // Saved while Groq was the engine: it is neither shown nor sent to Deepgram.
      cloudTranscriptionModelId: 'whisper-large-v3-turbo',
    });
    try {
      await page.evaluate((value) => {
        window.localStorage.setItem('vozella.theme', value);
      }, theme);
      await page.reload();
      await expect(page.getByRole('navigation')).toBeVisible();
      await toSettings(page);
      await expect(choice(page).getByRole('radio', { name: /^Deepgram/ })).toBeChecked();
      // Without the key: the notice, the key field and the open guide.
      const guide = section(page).getByRole('button', { name: 'How to get a Deepgram API key' });
      await expect(guide).toHaveAttribute('aria-expanded', 'true');
      await expect(
        section(page).getByRole('link', { name: /Open the Deepgram API keys page/ }),
      ).toHaveAttribute('href', 'https://console.deepgram.com/');
      await expect(
        section(page).getByRole('group', { name: 'Live transcription during recording' }),
      ).toHaveAccessibleDescription('Add your Deepgram API key to use this.');
      await section(page).scrollIntoViewIfNeeded();
      expect(await serious(page)).toEqual([]);

      // With the key: saved, the guide folded, the one model named, live captions as you speak.
      await keyField(page).fill(KEY);
      await keyField(page).press('Enter');
      await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
      await expect(guide).toHaveAttribute('aria-expanded', 'false');
      const setup = section(page).getByRole('group', { name: 'Deepgram setup' });
      await expect(setup.getByRole('group', { name: 'Transcription model' })).toContainText(
        'Nova-3',
      );
      await expect(setup.getByRole('combobox')).toHaveCount(0);
      await expect(setup.getByText(/whisper/i)).toHaveCount(0);
      await expect(
        setup.getByText(
          'This key is used only to transcribe. Summaries and chat use the engine you choose for them.',
        ),
      ).toBeVisible();
      await expect(
        section(page).getByRole('group', { name: 'Live transcription during recording' }),
      ).toHaveAccessibleDescription(
        'Shows captions on screen while you record. With Deepgram the text appears as you speak.',
      );
      const labels = section(page).getByRole('switch', { name: 'Speaker labels' });
      await expect(labels).toBeDisabled();
      await expect(labels).toHaveAccessibleDescription(
        'Not available with Deepgram in this version. Your choice is kept for when you transcribe on this PC.',
      );
      expect(await serious(page)).toEqual([]);
    } finally {
      await closeApp(launched, page);
    }
  });
}

test("Electron's main process WebSocket sends the request header a live session carries its key in", async () => {
  // A server on this PC that only looks at the upgrade request and drops the connection. Nothing
  // leaves the machine and the "key" is a made-up word.
  const upgrades: http.IncomingHttpHeaders[] = [];
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    upgrades.push(request.headers);
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const { launched, page } = await open();
  try {
    // The same call `globalLiveSocket` makes, in the process that makes it in the app.
    const seen = await launched.app.evaluate(
      (_electron, url) =>
        new Promise<{ events: string[]; code: number | null; node: string; electron: string }>(
          (resolve) => {
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
            const socket = new Socket(url, { headers: { Authorization: 'Token e2e-not-a-key' } });
            socket.addEventListener('error', () => events.push('error'));
            socket.addEventListener('close', (event) => {
              events.push('close');
              done(event.code ?? null);
            });
            setTimeout(() => {
              done(null);
            }, 15_000);
          },
        ),
      `ws://127.0.0.1:${String(port)}/v1/listen?model=nova-3`,
    );
    test.info().annotations.push({
      type: 'electron-websocket',
      description: `electron ${seen.electron}, node ${seen.node}: events ${seen.events.join(',')}, close code ${String(seen.code)}`,
    });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.authorization).toBe('Token e2e-not-a-key');
    expect(upgrades[0]?.upgrade?.toLowerCase()).toBe('websocket');
    // A refused upgrade ends as it does against a provider that refuses the key: error, then close.
    expect(seen.events).toEqual(['error', 'close']);
    expect(seen.code).toBe(1006);
  } finally {
    await closeApp(launched, page);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
