import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';
import { writeMeeting } from './library-data';

// The model picker beside Send against the fake build: Claude Code is on PATH, Codex is missing,
// no API key is saved and Local has no model downloaded, so Settings stay on Local (not ready).
// A pick lives for the conversation and never touches the Settings engine.
test.describe.configure({ timeout: 150_000 });

const seed = (dataRoot: string): void => {
  writeMeeting(path.join(dataRoot, 'meetings'), {
    id: 'b0000000-0000-4000-8000-000000000000',
    title: 'Pricing review',
    recordedAt: '2026-09-03T10:30:00.0000000-05:00',
    summary: 'Agreed to keep the founder price.',
    transcript: '[00:00.00-00:05.00] Ana: we keep five dollars',
  });
};

interface Rig {
  readonly launched: LaunchedApp;
  readonly page: Page;
  readonly filesDir: string;
  readonly promptLog: string;
}

async function open(): Promise<Rig> {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-e2e-picker-'));
  const promptLog = path.join(filesDir, 'prompts.log');
  const launched = await launchApp(
    { VOZELLA_E2E_SHOW: '1', VOZELLA_FAKE_CHAT_PROMPT_LOG: promptLog },
    seed,
  );
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  return { launched, page, filesDir, promptLog };
}

async function close(rig: Rig): Promise<void> {
  await rig.launched.close();
  fs.rmSync(rig.filesDir, { recursive: true, force: true });
}

const openPanel = async (page: Page): Promise<void> => {
  const launcher = page.getByTestId('BtnAiPanelOpen');
  const composer = page.getByTestId('TxtMeetingChat');
  await expect(launcher.or(composer).filter({ visible: true })).toBeVisible();
  if (await launcher.isVisible()) await launcher.click();
  await expect(composer).toBeVisible();
};

const settledAnimations = (page: Page): Promise<unknown> =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

const chip = (page: Page): Locator => page.getByTestId('BtnChatModel');
const popup = (page: Page): Locator => page.getByRole('dialog', { name: 'Models' });

const openPicker = async (page: Page): Promise<Locator> => {
  await expect(chip(page)).toBeEnabled();
  await chip(page).click();
  const dialog = popup(page);
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('TxtChatModelSearch')).toBeFocused();
  await settledAnimations(page);
  return dialog;
};

const settingsEngine = (page: Page): Promise<string> =>
  page.evaluate(async () => (await window.vozella.invoke('settings.getPage', {})).provider);

test('lists the engines by group, with what a missing one needs', async () => {
  const rig = await open();
  const { page } = rig;
  try {
    await openPanel(page);
    // Next to Send, on the composer's toolbar line.
    await expect(chip(page)).toBeVisible();
    const chipBox = await chip(page).boundingBox();
    const sendBox = await page.getByTestId('BtnMeetingChatSend').boundingBox();
    expect(chipBox && sendBox && chipBox.x + chipBox.width <= sendBox.x).toBe(true);

    const dialog = await openPicker(page);
    for (const name of ['On this PC', 'With a subscription', 'With your API key']) {
      await expect(dialog.getByRole('group', { name })).toBeVisible();
    }
    const codex = dialog.getByTestId('ItemChatModelSetup').filter({ hasText: 'Codex' });
    await expect(codex).toContainText('Not found');
    await expect(codex).toContainText('Install');
    const openai = dialog
      .getByTestId('ItemChatModelSetup')
      .filter({ has: page.getByText('OpenAI', { exact: true }) });
    await expect(openai).toContainText('Add key');

    // Guards the overlap: the popup sits wholly above the composer box, right edges aligned.
    const popupBox = await dialog.boundingBox();
    const composerBox = await page.getByTestId('BoxMeetingChatComposer').boundingBox();
    expect(popupBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    if (popupBox && composerBox) {
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(composerBox.y - 7);
      expect(
        Math.abs(popupBox.x + popupBox.width - (composerBox.x + composerBox.width)),
      ).toBeLessThanOrEqual(1);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(chip(page)).toBeFocused();
  } finally {
    await close(rig);
  }
});

test('a pick and its effort go with the send and leave Settings alone; New chat resets it', async () => {
  const rig = await open();
  const { page } = rig;
  try {
    await openPanel(page);
    const before = await settingsEngine(page);
    const defaultName = await chip(page).getAttribute('aria-label');

    const dialog = await openPicker(page);
    await dialog.getByRole('option', { name: 'Opus' }).click();
    await expect(dialog.getByRole('option', { name: 'Opus' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Effort from the keyboard: Tab from the search field reaches the bar, an arrow moves it.
    const effort = dialog.getByTestId('RadChatModelEffort');
    await expect(effort).toBeVisible();
    await page.keyboard.press('Tab');
    const radios = effort.getByRole('radio');
    await expect(radios.and(page.locator(':focus'))).toHaveCount(1);
    const startIndex = await radios.evaluateAll((items) =>
      items.findIndex((item) => item.getAttribute('aria-checked') === 'true'),
    );
    const options = await page.evaluate(async () => {
      const choices = await window.vozella.invoke('chat.getEngineChoices', {});
      return choices.engines.find((entry) => entry.engine === 'claude-code')?.effortOptions ?? [];
    });
    expect(options.length).toBeGreaterThan(1);
    const key = startIndex < options.length - 1 ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.press(key);
    const chosenIndex = key === 'ArrowRight' ? startIndex + 1 : startIndex - 1;
    await expect(radios.nth(chosenIndex)).toHaveAttribute('aria-checked', 'true');
    const chosenEffort = options[chosenIndex];

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(chip(page)).toContainText('Opus');

    await page.getByTestId('TxtMeetingChat').fill('What did we agree on price?');
    await page.getByTestId('BtnMeetingChatSend').click();
    const rows = page.getByTestId('ListMeetingChat').locator(':scope > li');
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('BtnMeetingChatCopy')).toBeVisible();

    const log = fs.readFileSync(rig.promptLog, 'utf8');
    expect(log).toContain('What did we agree on price?');
    expect(log).toContain('<<<ENGINE claude-code>>>');
    expect(log).toContain('<<<MODEL opus>>>');
    expect(log).toContain(`<<<EFFORT ${String(chosenEffort)}>>>`);
    expect(await settingsEngine(page)).toBe(before);

    // New chat starts again from the Settings default.
    await page.getByTestId('BtnMeetingChatNew').click();
    await expect(rows).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute('aria-label', defaultName ?? '');
    await expect(chip(page)).not.toContainText('Opus');
  } finally {
    await close(rig);
  }
});

test('Add key opens Settings on that engine and keeps the engine in use', async () => {
  const rig = await open();
  const { page } = rig;
  try {
    await openPanel(page);
    const before = await settingsEngine(page);
    const dialog = await openPicker(page);
    await dialog
      .getByTestId('ItemChatModelSetup')
      .filter({ has: page.getByText('OpenAI', { exact: true }) })
      .click();
    await expect(dialog).toBeHidden();

    const row = page.locator('button[data-engine="OpenAi"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(await settingsEngine(page)).toBe(before);
  } finally {
    await close(rig);
  }
});

test('the open picker has no serious accessibility violations, light and dark', async () => {
  const rig = await open();
  const { page } = rig;
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        window.localStorage.setItem('vozella.theme', value);
      }, theme);
      await page.reload();
      await expect(page.getByRole('navigation')).toBeVisible();
      await openPanel(page);
      await openPicker(page);
      await page.evaluate(() => document.fonts.ready);
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
          theme,
          id: violation.id,
          nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
        })),
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(popup(page)).toBeHidden();
    }
  } finally {
    await close(rig);
  }
});
