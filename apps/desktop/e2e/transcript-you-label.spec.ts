import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';
import { writeMeeting } from './library-data';

// The local user label in the Transcript tab: a stored `[ You ]` line reads "You" in English and
// "Tú" in Spanish, while Copy still gives the stored text. Real app, fake native adapters.

test.describe.configure({ timeout: 150_000, mode: 'serial' });

const MEETING = '7d2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c21';

const TRANSCRIPT = [
  'Recorded 2026-10-01 22:36',
  'Ended 2026-10-01 23:06',
  '[00:00.00-00:03.00] [ You ] Hola, empecemos.',
  '[00:03.00-00:06.00] [ Speaker-1 ] Perfecto, gracias.',
].join('\n');

function seed(dataRoot: string): void {
  writeMeeting(path.join(dataRoot, 'meetings'), {
    id: MEETING,
    title: 'Weekly sync',
    recordedAt: '2026-10-01T22:36:00.0000000+00:00',
    transcript: TRANSCRIPT,
  });
}

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({}, seed);
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.evaluate(async (meeting) => {
    await window.vozella.invoke('workspace.dispatch', {
      action: { type: 'selectMeeting', id: meeting },
    });
    await window.vozella.invoke('workspace.dispatch', {
      action: { type: 'openSession', tab: 'Transcript' },
    });
  }, MEETING);
  await expect(page).toHaveURL(/#\/session$/);
});

test.afterAll(async () => {
  await launched.close();
});

const lines = (): Promise<string[]> =>
  page.getByTestId('TxtTranscriptContent').locator('p').allTextContents();

test('shows the local user as You next to a numbered speaker in English', async () => {
  await expect(page.getByTestId('TxtTranscriptContent')).toBeVisible();
  const shown = await lines();
  expect(shown[2]).toBe('[00:00.00-00:03.00] [ You ] Hola, empecemos.');
  expect(shown[3]).toBe('[00:03.00-00:06.00] [ Speaker-1 ] Perfecto, gracias.');
});

test('shows the local user as Tú in Spanish, and Copy still gives the stored text', async () => {
  await page.evaluate(() => window.vozella.invoke('settings.setUiLanguage', { tag: 'es' }));
  const box = page.getByTestId('TxtTranscriptContent');
  await expect(box.locator('p').nth(2)).toHaveText('[00:00.00-00:03.00] [ Tú ] Hola, empecemos.');
  expect((await lines())[3]).toBe('[00:03.00-00:06.00] [ Speaker-1 ] Perfecto, gracias.');

  await launched.app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.getByTestId('BtnSessionCopy').click();
  await expect(page.getByTestId('InfoSessionCopy')).toBeVisible();
  const copied = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied.replace(/\r\n/g, '\n').trim()).toBe(TRANSCRIPT);

  await page.evaluate(() => window.vozella.invoke('settings.setUiLanguage', { tag: 'en-US' }));
  await expect(box.locator('p').nth(2)).toHaveText('[00:00.00-00:03.00] [ You ] Hola, empecemos.');
});
