import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  launchApp,
  openSettingsTab,
  READY_MODEL,
  restoreMain,
  type LaunchedApp,
  setMainContentSize,
} from './launch';

// Cloud transcription with the user's own API key (BYOK), in the real window on the fake native
// build: the key store is in memory, the cloud speech client hears a fixed script (one word per
// half second of audio) and can be made to fail, and the local engine is never on disk. No
// request leaves the PC and no account is used.
//
// Screenshots are written only with VOZELLA_SCREENSHOTS=1, to docs/screenshots/cloud-transcription
// or to VOZELLA_SCREENSHOT_DIR.

const shots = process.env.VOZELLA_SCREENSHOTS === '1';
const outDir =
  process.env.VOZELLA_SCREENSHOT_DIR ??
  path.resolve(__dirname, '../../../docs/screenshots/cloud-transcription');

const KEY = 'gsk-e2e-SECRET-0123456789';

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
      VOZELLA_E2E_SHOW: shots ? '1' : '0',
      ...env,
    },
    seed(settings),
  );
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await setMainContentSize(launched.app, 1180, 1000);
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

/** Saves the Groq key the way a test that is not about the key field does: through the channel. */
const saveKey = (page: Page): Promise<unknown> =>
  page.evaluate((key) => window.vozella.invoke('settings.setApiKey', { kind: 'Groq', key }), KEY);

/** Every saved meeting Markdown in the data root (the settings folder holds none). */
function meetings(launched: LaunchedApp): string[] {
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          return entry.name.endsWith('.md') ? [full] : [];
        })
      : [];
  return walk(path.join(launched.dataRoot, 'meetings')).map((file) =>
    fs.readFileSync(file, 'utf8'),
  );
}

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

test('a cloud engine without its key: Record asks for the key and never opens the download', async () => {
  const { launched, page } = await open();
  try {
    await toSettings(page);
    await expect(choice(page).getByRole('radio', { name: /^On this PC/ })).toBeChecked();
    await choice(page).getByRole('radio', { name: /^Groq/ }).click();
    await expect(choice(page).getByRole('radio', { name: /^Groq/ })).toBeChecked();
    await expect.poll(() => settingsFile(launched).transcriptionEngine).toBe('Groq');
    // Where the choice is made: who gets the audio, and that the key is still missing.
    await expect(
      section(page).getByText(
        'While Groq is selected, the audio of each meeting is sent to Groq to be turned into text.',
      ),
    ).toBeVisible();
    await expect(keyField(page)).toHaveAccessibleDescription(
      'No key saved yet. It is stored encrypted on this PC.',
    );

    await toRecord(page);
    const gate = page.getByTestId('setup-checklist');
    await expect(
      gate.getByText('Add your Groq API key to record. Nothing needs to be downloaded.'),
    ).toBeVisible();
    await expect(gate.getByText('Groq needs your API key. Add it in Settings.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up to record' })).toHaveCount(0);
    await expect(page.getByTestId('BtnRecord')).toHaveCount(0);

    await page.getByRole('button', { name: 'Add API key' }).click();
    // One action: Settings, with the key field in view and holding the focus.
    await expect(keyField(page)).toBeFocused();
    await expect(keyField(page)).toBeInViewport();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const status = await page.evaluate(() => window.vozella.invoke('transcription.getStatus', {}));
    expect(status).toMatchObject({
      engine: 'Groq',
      ready: false,
      cloudNotReadyReason: 'key-missing',
      // Nothing was downloaded on the way.
      modelInstalled: false,
      installing: null,
    });
  } finally {
    await closeApp(launched, page);
  }
});

test('with a key and Groq chosen, a take is transcribed live and saved with that transcript', async () => {
  const { launched, page } = await open();
  try {
    await toSettings(page);
    await choice(page).getByRole('radio', { name: /^Groq/ }).click();
    await keyField(page).fill(KEY);
    await section(page).getByRole('button', { name: 'Save key' }).click();
    await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
    await expect(keyField(page)).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    expect(JSON.stringify(settingsFile(launched))).not.toContain(KEY);
    // The live switch follows the saved key without a restart.
    const live = section(page).getByRole('switch', { name: 'Live transcription during recording' });
    await expect(live).toBeEnabled();
    await expect(live).toBeChecked();

    await toRecord(page);
    // The gate follows too: no setup panel, and Record is there.
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Title' }).fill('Cloud take');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    const pane = page.getByRole('region', { name: 'Live transcript' });
    await expect(pane).toContainText('Captions appear here a few seconds after people speak.');
    // The first piece is about 15 s of audio; its text arrives after that.
    await expect(pane).toContainText('Buenos días a todos', { timeout: 60_000 });
    await expect(page.getByTestId('live-notice')).toHaveCount(0);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() => meetings(launched).find((text) => text.includes('Cloud take')) ?? '', {
        timeout: 60_000,
      })
      .toContain('Buenos días a todos');
    // The saved lines carry the provider's punctuation and capitals, not its bare word list.
    expect(meetings(launched).find((text) => text.includes('Cloud take'))).toMatch(
      /\[\d{2}:\d{2}\.\d{2}-\d{2}:\d{2}\.\d{2}\] Buenos días a todos y gracias por venir\. Hoy revisamos el presupuesto del trimestre\./,
    );
    await restoreMain(launched.app);
    await expect(page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    // The local engine was never installed: the cloud engine did all of it.
    const status = await page.evaluate(() => window.vozella.invoke('transcription.getStatus', {}));
    expect(status).toMatchObject({ engine: 'Groq', ready: true, modelInstalled: false });
  } finally {
    await closeApp(launched, page);
  }
});

test('the download dialog of the local engine offers the cloud, and lands on the choice', async () => {
  const { launched, page } = await open();
  try {
    await toRecord(page);
    await page.getByRole('button', { name: 'Set up to record' }).click();
    await page
      .getByRole('dialog', { name: 'Set up recording' })
      .getByRole('button', { name: 'Set up', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Download transcription engine' });
    await expect(dialog.getByRole('progressbar')).toBeVisible();
    await expect(
      dialog.getByText(
        'No room for the download, or a slow computer? You can transcribe in the cloud with your own API key instead.',
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Use the cloud instead' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(choice(page)).toBeInViewport();
    // Nothing is chosen for the user: this PC is still selected, and it holds the focus.
    const local = choice(page).getByRole('radio', { name: /^On this PC/ });
    await expect(local).toBeChecked();
    await expect(local).toBeFocused();
    expect(settingsFile(launched)).not.toHaveProperty('transcriptionEngine');
    await expect
      .poll(async () => {
        const status = await page.evaluate(() =>
          window.vozella.invoke('transcription.getStatus', {}),
        );
        return [status.engine, status.modelInstalled, status.installing];
      })
      .toEqual(['Local', false, null]);
  } finally {
    await closeApp(launched, page);
  }
});

test('a key the provider refuses: the take says so while it records, and again after Stop', async () => {
  const { launched, page } = await open(
    { transcriptionEngine: 'Groq' },
    { VOZELLA_FAKE_STT_FAIL: 'KeyInvalid' },
  );
  try {
    await saveKey(page);
    await toRecord(page);
    await page.getByRole('textbox', { name: 'Title' }).fill('Refused key');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    const notice = page.getByTestId('live-notice');
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice).toContainText('Live captions stopped');
    await expect(notice).toContainText(
      'Fake speech did not accept your API key. Check it in Settings. The recording continues, and you can transcribe it after you stop.',
    );
    // Calm: a polite status, not an alert, and the take is still recording.
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await expect(page.getByTestId('recording-status')).toContainText('Recording...');
    await restoreMain(launched.app);
    expect(await serious(page)).toEqual([]);

    await page.getByRole('button', { name: 'Stop' }).click();
    await restoreMain(launched.app);
    await expect(
      page.getByText(
        /The meeting keeps its audio, so you can retranscribe it\. Transcription failed: Fake speech did not accept your API key/,
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(notice).toHaveCount(0);
    // The audio is kept and the meeting is saved, with no transcript yet.
    expect(meetings(launched).some((text) => text.includes('Refused key'))).toBe(true);
  } finally {
    await closeApp(launched, page);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Transcription section in cloud mode has no serious violations in ${theme}`, async () => {
    const { launched, page } = await open({ transcriptionEngine: 'Groq' });
    try {
      await page.evaluate((value) => {
        window.localStorage.setItem('vozella.theme', value);
      }, theme);
      await page.reload();
      await expect(page.getByRole('navigation')).toBeVisible();
      await toSettings(page);
      // Without the key: the notice, the key field and the open guide.
      const guide = section(page).getByRole('button', { name: 'How to get a Groq API key' });
      await expect(guide).toHaveAttribute('aria-expanded', 'true');
      await expect(
        section(page).getByRole('link', { name: /Open the Groq API keys page/ }),
      ).toHaveAttribute('href', 'https://console.groq.com/keys');
      await section(page).scrollIntoViewIfNeeded();
      expect(await serious(page)).toEqual([]);

      // The whole choice works from the keyboard: arrows move the selection inside the group.
      await choice(page).getByRole('radio', { name: /^Groq/ }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(choice(page).getByRole('radio', { name: /^OpenAI/ })).toBeChecked();
      await expect.poll(() => settingsFile(launched).transcriptionEngine).toBe('OpenAi');
      await page.keyboard.press('ArrowUp');
      await expect(choice(page).getByRole('radio', { name: /^Groq/ })).toBeChecked();
      await expect.poll(() => settingsFile(launched).transcriptionEngine).toBe('Groq');

      // With the key: saved, the guide folded, the model picker, labels disabled with the reason.
      await keyField(page).fill(KEY);
      await keyField(page).press('Enter');
      await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
      await expect(guide).toHaveAttribute('aria-expanded', 'false');
      await expect(section(page).getByRole('combobox', { name: 'Transcription model' })).toHaveText(
        /Whisper Large v3 Turbo/,
      );
      const labels = section(page).getByRole('switch', { name: 'Speaker labels' });
      await expect(labels).toBeDisabled();
      await expect(labels).toHaveAccessibleDescription(
        'Not available with Groq in this version. Your choice is kept for when you transcribe on this PC.',
      );
      expect(await serious(page)).toEqual([]);
    } finally {
      await closeApp(launched, page);
    }
  });
}

test.describe('screenshots', () => {
  test.skip(!shots, 'set VOZELLA_SCREENSHOTS=1 to capture');

  async function shot(page: Page, name: string, target?: Locator): Promise<void> {
    fs.mkdirSync(outDir, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await (target ?? page.locator('body')).scrollIntoViewIfNeeded();
    // Fonts and the fade of a panel that just opened; nothing is asserted after this wait.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, name) });
  }

  for (const [locale, tag] of [
    ['en', 'en-US'],
    ['es', 'es'],
  ] as const) {
    test(`the Transcription section and the Record gate (${locale})`, async () => {
      const { launched, page } = await open({ uiLanguage: tag });
      try {
        await toSettings(page);
        await expect(section(page).getByRole('radiogroup')).toBeVisible();
        await shot(page, `section-local-${locale}.png`, section(page));

        await section(page).getByRole('radio', { name: /^Groq/ }).click();
        await expect(section(page).getByTestId('cloud-engine-setup')).toBeVisible();
        await shot(page, `section-cloud-key-missing-${locale}.png`, section(page));

        await toRecord(page);
        await expect(page.getByTestId('BtnAddApiKey')).toBeVisible();
        await shot(page, `record-gate-cloud-${locale}.png`);

        await toSettings(page);
        await saveKey(page);
        await page.reload();
        await expect(page.getByRole('navigation')).toBeVisible();
        await toSettings(page);
        await expect(section(page).getByTestId('cloud-engine-setup')).toBeVisible();
        await shot(page, `section-cloud-key-set-${locale}.png`, section(page));
      } finally {
        await closeApp(launched, page);
      }
    });
  }

  test('the cloud way out in the download dialog, and the live notice', async () => {
    const first = await open();
    try {
      await toRecord(first.page);
      await first.page.getByRole('button', { name: 'Set up to record' }).click();
      await first.page
        .getByRole('dialog', { name: 'Set up recording' })
        .getByRole('button', { name: 'Set up', exact: true })
        .click();
      await expect(first.page.getByRole('button', { name: 'Use the cloud instead' })).toBeVisible();
      await shot(first.page, 'engine-dialog-cloud-alternative-en.png');
    } finally {
      await closeApp(first.launched, first.page);
    }

    const second = await open(
      { transcriptionEngine: 'Groq' },
      { VOZELLA_FAKE_STT_FAIL: 'QuotaExceeded' },
    );
    try {
      await saveKey(second.page);
      await toRecord(second.page);
      await second.page.getByTestId('BtnRecord').click();
      await expect(second.page.getByTestId('live-notice')).toBeVisible({ timeout: 60_000 });
      await restoreMain(second.launched.app);
      await shot(second.page, 'live-notice-en.png');
    } finally {
      await closeApp(second.launched, second.page);
    }
  });
});
