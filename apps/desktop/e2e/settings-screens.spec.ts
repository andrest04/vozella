import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';

// Regenerates docs/port/screens/settings-i18n/*.png. Opt in with VOZELLA_SCREENSHOTS=1.
test.skip(process.env.VOZELLA_SCREENSHOTS !== '1', 'set VOZELLA_SCREENSHOTS=1 to capture');

const outDir = path.resolve(__dirname, '../../../docs/port/screens/settings-i18n');

let launched: LaunchedApp;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp({ VOZELLA_E2E_SHOW: '1' });
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1120, 1500);
  });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await launched.close();
});

async function useTheme(theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('vozella.theme', value);
  }, theme);
  await page.reload();
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.getByRole('heading', { level: 2, name: 'Summary provider' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

/** Opens an engine's row in the summary engine list, unless it is open already. */
async function openEngine(name: string): Promise<void> {
  const row = page.getByRole('button', { name, exact: true });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

for (const theme of ['light', 'dark'] as const) {
  test(`settings in ${theme}`, async () => {
    await useTheme(theme);
    await openEngine('Local (on this device)');
    if (theme === 'light') {
      await page.getByRole('button', { name: 'Change model' }).click();
      const dialog = page.getByRole('dialog', { name: 'Summary models' });
      const group = dialog.getByRole('radiogroup', { name: 'Summary models' });
      const row = group.locator(':scope > div').filter({
        has: page.getByRole('radio', { name: /Granite 4\.0 Micro/ }),
      });
      await row.getByRole('button', { name: 'Download' }).click();
      await page.getByRole('radio', { name: /Granite 4\.0 Micro/ }).click();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toBeHidden();
    }
    await shot(`settings-local-${theme}`);

    await openEngine('Claude Code CLI');
    await expect(page.getByText('Detected on PATH.')).toBeVisible();
    await shot(`settings-claude-${theme}`);

    await openEngine('Local (on this device)');
  });
}

test('the restart prompt, in Spanish', async () => {
  await useTheme('light');
  await page.getByRole('combobox', { name: 'App language' }).click();
  await page.getByRole('option', { name: 'Español' }).click();
  await expect(page.getByRole('dialog', { name: 'Reinicio necesario' })).toBeVisible();
  await shot('settings-restart-prompt-es-light');
  await page.getByRole('button', { name: 'Más tarde' }).click();
  await shot('settings-es-light');
});
