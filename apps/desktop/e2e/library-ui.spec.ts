import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, openSettingsTab, type LaunchedApp } from './launch';
import { writeMeeting } from './library-data';

// Main flows of the Library screen and the Settings data card, in the real app with fake native
// adapters and a throwaway data root. Files are written the way the app writes them.

// Hidden windows throttle animation frames, so every action waits longer than in a shown one.
test.describe.configure({ timeout: 150_000 });

let launched: LaunchedApp;
let page: Page;
let libraryRoot: string;

const ID_A = '3f2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c0d';
const ID_B = '4a2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c0e';
const ID_C = '5b2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c0f';

test.beforeAll(async () => {
  launched = await launchApp();
  libraryRoot = path.join(launched.dataRoot, 'meetings');
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  // Never open a real file manager from a test.
  await launched.app.evaluate(({ shell }) => {
    shell.openPath = () => Promise.resolve('');
  });
});

test.afterAll(async () => {
  await launched.close();
});

const goTo = async (name: 'Library' | 'Settings' | 'Record'): Promise<void> => {
  await page.getByRole('navigation').getByRole('link', { name }).click();
};

test('an empty library points at recording, and the shell follows the request', async () => {
  await goTo('Library');
  await expect(page.getByText('No meetings recorded yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Record a meeting' }).click();
  await expect(page).toHaveURL(/#\/record$/);
});

test('browse, search, open a meeting and its summary', async () => {
  writeMeeting(libraryRoot, {
    id: ID_A,
    title: 'Standup',
    recordedAt: '2026-09-01T09:00:00.0000000+00:00',
    summary: '## Plan\nShip the release on Friday',
  });
  writeMeeting(libraryRoot, {
    id: ID_B,
    title: 'Planning',
    recordedAt: '2026-09-03T09:00:00.0000000+00:00',
    transcript: 'Hola a todos',
  });
  await goTo('Settings');
  await goTo('Library');

  const list = page.getByRole('grid', { name: 'Library' });
  const rows = list.locator('[data-row-id]');
  await expect(rows).toHaveCount(2);
  // Newest first, each with a snippet.
  await expect(rows.first()).toContainText('Planning');
  await expect(rows.first()).toContainText('Hola a todos');
  await expect(rows.nth(1)).toContainText('Ship the release on Friday');

  await page.getByRole('searchbox').fill('stand');
  await expect(rows).toHaveCount(1);
  await page.getByRole('searchbox').fill('nothing here');
  await expect(page.getByText('No meetings match your search.')).toBeVisible();

  // The second stage finds a word that is only in the transcript, through the real channel.
  await page.getByRole('searchbox').fill('hola');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Planning');
  await expect(rows.first().locator('mark')).toHaveText('Hola');
  await page.getByRole('searchbox').fill('');

  // A click previews, and leaves the screen alone.
  const standup = list.getByRole('row', { name: /Standup/ });
  await standup.click();
  await expect(standup).toHaveAttribute('data-cursor', 'true');
  const preview = page.getByTestId('library-preview');
  await expect(preview.getByRole('heading', { level: 2, name: 'Standup' })).toBeVisible();
  await expect(preview.getByText('Ship the release on Friday')).toBeVisible();
  await expect(page).toHaveURL(/#\/library$/);

  // Double click opens, and so does the preview's button.
  await standup.dblclick();
  await expect(page).toHaveURL(/#\/session$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Standup' })).toBeVisible();

  await page.getByRole('button', { name: 'Back' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Planning' });
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Open summary' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible();
  const state = await page.evaluate(() => window.vozella.invoke('workspace.getState', {}));
  expect(state).toMatchObject({
    selectedMeetingId: ID_B,
    sessionTab: 'Summary',
    currentShellTag: 'Session',
  });
});

test('a meeting is deleted only after confirming, with Cancel focused', async () => {
  writeMeeting(libraryRoot, {
    id: ID_C,
    title: 'Retro',
    recordedAt: '2026-09-04T09:00:00.0000000+00:00',
  });
  await goTo('Settings');
  await goTo('Library');
  const row = page.getByRole('row').filter({ hasText: 'Retro' });
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this meeting?' });
  await expect(
    confirm.getByText('This moves "Retro" and its recording to the Recycle Bin.'),
  ).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Retro' })).toHaveCount(0);
  expect(fs.existsSync(path.join(libraryRoot, 'Inbox', '2026-09-04 Retro.md'))).toBe(false);
});

test('Settings shows where data lives, follows a picked folder, and refuses a real data folder here', async () => {
  await goTo('Settings');
  await openSettingsTab(page, 'general');
  await expect(page.getByRole('heading', { level: 2, name: 'Data' })).toBeVisible();
  await expect(page.getByText(libraryRoot, { exact: true })).toBeVisible();
  await expect(page.getByText(path.join(launched.dataRoot, 'app'), { exact: true })).toBeVisible();

  // Open folder asks the shell, which is stubbed above, and reports nothing wrong.
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByText(/could not be opened/)).toHaveCount(0);

  const picked = path.join(launched.dataRoot, 'picked');
  fs.mkdirSync(picked);
  writeMeeting(picked, {
    id: '6c2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c10',
    title: 'Elsewhere',
    recordedAt: '2026-09-05T09:00:00.0000000+00:00',
  });
  await launched.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
  }, picked);
  await page.getByRole('button', { name: 'Choose folder' }).click();
  await expect(page.getByText(picked, { exact: true })).toBeVisible();
  await goTo('Library');
  await expect(page.getByRole('row').filter({ hasText: 'Elsewhere' })).toBeVisible();

  const forbidden = path.join(launched.dataRoot, 'x', 'MeetingLive');
  fs.mkdirSync(forbidden, { recursive: true });
  await launched.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
  }, forbidden);
  await goTo('Settings');
  await openSettingsTab(page, 'general');
  await page.getByRole('button', { name: 'Choose folder' }).click();
  await expect(page.getByText(/That folder cannot be used/)).toBeVisible();
  await expect(page.getByText(picked, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Use the default folder' }).click();
  await expect(page.getByText(libraryRoot, { exact: true })).toBeVisible();
});

test('the library is panes that scroll on their own, under the title bar and over the chat', async () => {
  const resize = async (width: number, height: number): Promise<void> => {
    await launched.app.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
      },
      { width, height },
    );
  };
  const before = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getContentSize(),
  );
  await goTo('Library');
  const main = page.locator('#content');
  await expect.poll(() => main.evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden');

  await resize(1180, 760);
  const preview = page.getByTestId('library-preview');
  await expect(preview).toBeVisible();
  // clamp(340px, 38%, 440px) of the width the two panes share.
  const list = page.getByTestId('library-list-pane');
  await expect
    .poll(async () => {
      const pane = (await list.boundingBox())?.width ?? 0;
      const shared = (await list.locator('xpath=..').boundingBox())?.width ?? 0;
      return Math.abs(pane - Math.min(440, Math.max(340, shared * 0.38)));
    })
    .toBeLessThan(1);
  // The panes start inside the content area; the AI panel docks beside it, never over it.
  const paneBottom = (await list.boundingBox())?.y ?? 0;
  const mainBox = await main.boundingBox();
  expect(paneBottom).toBeGreaterThanOrEqual(mainBox?.y ?? Infinity);

  // Below 760 px of content there is no preview. The window minimum leaves 728 px.
  await resize(960, 700);
  await expect(preview).toHaveCount(0);

  await goTo('Settings');
  await expect.poll(() => main.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  if (before?.[0] && before[1]) await resize(before[0], before[1]);
});

test('no serious accessibility violations on the library, its dialogs and the data card', async () => {
  const check = async (): Promise<void> => {
    // Contrast is only meaningful at rest: let enter and exit animations settle first, skipping
    // endless ones such as spinners.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    // AxeBuilder opens a second page, which Electron does not support: inject axe directly.
    await page.evaluate(axe.source);
    const results = await page.evaluate(() =>
      (window as unknown as { axe: typeof axe }).axe.run(document),
    );
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(
      serious.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
      })),
    ).toEqual([]);
  };
  writeMeeting(path.join(launched.dataRoot, 'meetings'), {
    id: '7d2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c11',
    title: 'Accessibility check',
    recordedAt: '2026-09-06T09:00:00.0000000+00:00',
    summary: 'A short summary',
  });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      window.localStorage.setItem('vozella.theme', value);
    }, theme);
    await page.reload();
    await goTo('Library');
    await expect(page.getByRole('grid', { name: 'Library' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await check();

    // The Move to project popover, opened from the row of the meeting.
    await page
      .getByRole('row', { name: /Accessibility check/ })
      .getByRole('button', { name: 'More actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Move to project' }).click();
    await expect(page.getByRole('combobox', { name: 'Search projects' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await check();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Search projects' })).toHaveCount(0);

    await goTo('Settings');
    await openSettingsTab(page, 'general');
    await expect(page.getByRole('heading', { level: 2, name: 'Data' })).toBeVisible();
    await check();
  }
});
