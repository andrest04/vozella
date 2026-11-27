import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { restoreMain } from './launch';
import {
  choice,
  closeApp,
  filesOf,
  keyField,
  liveUpdates,
  mainProcessUpgrade,
  meetings,
  open,
  recordLiveUpdates,
  saveKey,
  section,
  serious,
  settingsFile,
  toRecord,
  toSettings,
} from './helpers/streaming-transcription';

// Streaming cloud transcription (ElevenLabs Scribe) with the user's own API key, in the real window
// on the fake native build: the key store is in memory, the live session is the same scripted one
// every streaming engine gets there (one word per half second of audio, a final when the phrase
// ends, and it can be made to refuse the key), and the upload client of the pass after Stop hears
// the same script. No request leaves the PC, no account and no real key is used, and the data root
// is a temp folder.

const KEY = 'xi-e2e-SECRET-0123456789';

test.describe.configure({ timeout: 150_000 });

test('ElevenLabs with its key: the take streams as it is said, and Stop keeps that transcript without a second pass', async () => {
  // The upload client refuses every request: a pass after Stop, if one ran, would fail in view.
  // The live session opens and answers 1.5 s behind the audio, as a real one is a little behind.
  const { launched, page } = await open(
    {},
    { VOZELLA_FAKE_STT_FAIL: 'KeyInvalid', VOZELLA_FAKE_STREAM_DELAY_MS: '1500' },
  );
  try {
    await toSettings(page);
    await choice(page)
      .getByRole('radio', { name: /^ElevenLabs/ })
      .click();
    await expect(choice(page).getByRole('radio', { name: /^ElevenLabs/ })).toBeChecked();
    await expect.poll(() => settingsFile(launched).transcriptionEngine).toBe('ElevenLabs');
    const setup = section(page).getByRole('group', { name: 'ElevenLabs setup' });
    await expect(
      setup.getByText(
        'While ElevenLabs is selected, the audio of each meeting is sent to ElevenLabs to be turned into text.',
      ),
    ).toBeVisible();

    // Without the key the Record gate asks for it, by the provider's name, and for nothing else.
    await toRecord(page);
    const gate = page.getByTestId('setup-checklist');
    await expect(
      gate.getByText('Add your ElevenLabs API key to record. Nothing needs to be downloaded.'),
    ).toBeVisible();
    await expect(
      gate.getByText('ElevenLabs needs your API key. Add it in Settings.'),
    ).toBeVisible();
    await expect(page.getByTestId('BtnRecord')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add API key' }).click();
    await expect(keyField(page)).toBeFocused();

    await keyField(page).fill(KEY);
    await section(page).getByRole('button', { name: 'Save key' }).click();
    await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
    await expect(keyField(page)).toHaveValue('');
    // The key stays in the main process: not in the window, not in the settings file.
    expect(await page.content()).not.toContain(KEY);
    expect(JSON.stringify(settingsFile(launched))).not.toContain(KEY);
    const live = section(page).getByRole('switch', { name: 'Live transcription during recording' });
    await expect(live).toBeEnabled();
    await expect(live).toBeChecked();

    await toRecord(page);
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
    await recordLiveUpdates(page);
    await page.getByRole('textbox', { name: 'Title' }).fill('Scribe take');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    const pane = page.getByRole('region', { name: 'Live transcript' });

    // The first words are on screen long before a 15 s piece could have been uploaded, and the
    // whole first phrase after it was said.
    await expect(pane).toContainText('Buenos días', { timeout: 20_000 });
    await expect(pane).toContainText('Buenos días a todos y gracias por venir.', {
      timeout: 30_000,
    });
    await expect(pane).toContainText('Hoy revisamos', { timeout: 30_000 });
    await expect(page.getByTestId('live-notice')).toHaveCount(0);

    const updates = await liveUpdates(page);
    // Interim text grows before anything is committed, then the final result commits the phrase.
    const interim = new Set(
      updates.filter((update) => update.committedText === '').map((update) => update.displayText),
    );
    expect(interim.size).toBeGreaterThan(1);
    const committed = updates.find((update) => update.committedText !== '');
    expect(committed?.committedText).toMatch(/\] Buenos días a todos y gracias por venir\.$/);
    expect(JSON.stringify(updates)).not.toContain(KEY);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() => meetings(launched).find((text) => text.includes('Scribe take')) ?? '', {
        timeout: 60_000,
      })
      .toMatch(
        /\[\d{2}:\d{2}\.\d{2}-\d{2}:\d{2}\.\d{2}\] Buenos días a todos y gracias por venir\./,
      );
    await restoreMain(launched.app);
    await expect(page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 60_000 });
    // No second pass ran: the upload client would have refused it.
    await expect(page.getByText(/^Done\. Transcript (and summary )?available/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/transcription failed/i)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const status = await page.evaluate(() => window.vozella.invoke('transcription.getStatus', {}));
    expect(status).toMatchObject({
      engine: 'ElevenLabs',
      ready: true,
      cloudNotReadyReason: null,
      liveDroppedPercent: 0,
      modelInstalled: false,
    });
    expect(JSON.stringify(status)).not.toContain(KEY);
  } finally {
    await closeApp(launched, page);
  }
});

test('a key ElevenLabs refuses: the live captions stop with the reason, the take records on, and the audio is kept and transcribed after Stop', async () => {
  const { launched, page } = await open(
    { transcriptionEngine: 'ElevenLabs' },
    { VOZELLA_FAKE_STREAM_FAIL: 'KeyInvalid' },
  );
  try {
    await saveKey(page, 'ElevenLabs', KEY);
    await toRecord(page);
    await page.getByRole('textbox', { name: 'Title' }).fill('Refused Scribe');
    await page.getByTestId('BtnRecord').click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    const notice = page.getByTestId('live-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Live captions stopped');
    await expect(notice).toContainText(
      'Fake streaming speech did not accept your API key. Check it in Settings. The recording continues, and you can transcribe it after you stop.',
    );
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
      .poll(() => meetings(launched).find((text) => text.includes('Refused Scribe')) ?? '', {
        timeout: 60_000,
      })
      .toContain('Buenos días');
    await restoreMain(launched.app);
    await expect(page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 60_000 });
    await expect(notice).toHaveCount(0);
    const audio = filesOf(launched, '.wav');
    expect(audio.length).toBeGreaterThan(0);
    expect(fs.statSync(audio[0] ?? '').size).toBeGreaterThan(44);
  } finally {
    await closeApp(launched, page);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Transcription section with ElevenLabs selected has no serious violations in ${theme}, and its model choice is saved`, async () => {
    const { launched, page } = await open({
      transcriptionEngine: 'ElevenLabs',
      // Saved while Deepgram was the engine: it is neither shown nor sent to ElevenLabs.
      cloudTranscriptionModelId: 'nova-3',
    });
    try {
      await page.evaluate((value) => {
        window.localStorage.setItem('vozella.theme', value);
      }, theme);
      await page.reload();
      await expect(page.getByRole('navigation')).toBeVisible();
      await toSettings(page);
      await expect(choice(page).getByRole('radio', { name: /^ElevenLabs/ })).toBeChecked();
      const setup = section(page).getByRole('group', { name: 'ElevenLabs setup' });
      // Without the key: the notice, the key field and the open guide.
      const guide = setup.getByRole('button', { name: 'How to get your ElevenLabs API key' });
      await expect(guide).toHaveAttribute('aria-expanded', 'true');
      await expect(
        setup.getByRole('link', { name: /Open the ElevenLabs API keys page/ }),
      ).toHaveAttribute('href', 'https://elevenlabs.io/app/settings/api-keys');
      await expect(
        section(page).getByRole('group', { name: 'Live transcription during recording' }),
      ).toHaveAccessibleDescription('Add your ElevenLabs API key to use this.');
      await section(page).scrollIntoViewIfNeeded();
      expect(await serious(page)).toEqual([]);

      // With the key: saved, the guide folded, the model picker, live captions as you speak.
      await keyField(page).fill(KEY);
      await keyField(page).press('Enter');
      await expect(section(page).getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
      await expect(guide).toHaveAttribute('aria-expanded', 'false');
      await expect(
        setup.getByText(
          'This key is used only to transcribe. Summaries and chat use the engine you choose for them.',
        ),
      ).toBeVisible();
      await expect(
        section(page).getByRole('group', { name: 'Live transcription during recording' }),
      ).toHaveAccessibleDescription(
        'Shows captions on screen while you record. With ElevenLabs the text appears as you speak.',
      );
      const labels = section(page).getByRole('switch', { name: 'Speaker labels' });
      await expect(labels).toBeDisabled();
      await expect(labels).toHaveAccessibleDescription(
        'Not available with ElevenLabs in this version. Your choice is kept for when you transcribe on this PC.',
      );
      const picker = setup.getByRole('combobox', { name: 'Transcription model' });
      await expect(picker).toHaveText(/Scribe v2/);
      await expect(setup.getByText(/nova/i)).toHaveCount(0);
      expect(await serious(page)).toEqual([]);

      await picker.click();
      await expect(page.getByRole('option')).toHaveText(['Scribe v2', 'Scribe v3']);
      await page.getByRole('option', { name: 'Scribe v3' }).click();
      await expect(picker).toHaveText(/Scribe v3/);
      await expect.poll(() => settingsFile(launched).cloudTranscriptionModelId).toBe('scribe_v3');
    } finally {
      await closeApp(launched, page);
    }
  });
}

test("Electron's main process WebSocket sends the xi-api-key header a Scribe live session carries its key in", async () => {
  // The same call `globalLiveSocket` makes for ElevenLabs, in the process that makes it in the
  // app, to a server on this PC. The "key" is a made-up word, and it never goes in the URL.
  const { launched, page } = await open();
  try {
    const { upgrades, seen } = await mainProcessUpgrade(
      launched,
      '/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000',
      { 'xi-api-key': 'e2e-not-a-key' },
    );
    test.info().annotations.push({
      type: 'electron-websocket',
      description: `electron ${seen.electron}, node ${seen.node}: events ${seen.events.join(',')}, close code ${String(seen.code)}`,
    });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.['xi-api-key']).toBe('e2e-not-a-key');
    expect(upgrades[0]?.authorization).toBeUndefined();
    expect(upgrades[0]?.upgrade?.toLowerCase()).toBe('websocket');
    expect(seen.events).toEqual(['error', 'close']);
    expect(seen.code).toBe(1006);
  } finally {
    await closeApp(launched, page);
  }
});
