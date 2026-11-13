import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './launch';

// The API key engines (BYOK) in Settings, in the real window on the fake native build: the key
// store is in memory and Verify answers from a fixed model list, so no request leaves the PC.

test.describe.configure({ timeout: 90_000 });

const SECRET = 'sk-e2e-SECRET-0123456789';

async function seriousViolations(page: Page): Promise<unknown[]> {
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

test('OpenAI: save a key, see it saved but never shown, verify it, and pass axe', async () => {
  const launched = await launchApp({ VOZELLA_E2E_SHOW: '1' });
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByRole('navigation')).toBeVisible();
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1120, 1000);
    });
    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await expect(page.getByRole('heading', { level: 2, name: 'Summary provider' })).toBeVisible();

    const group = page.getByRole('radiogroup', { name: 'Choose where summaries are generated' });
    await group.getByRole('radio', { name: 'OpenAI', exact: true }).click();
    const settingsFile = path.join(launched.dataRoot, 'app', 'settings.json');
    await expect
      .poll(() =>
        fs.existsSync(settingsFile)
          ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
              .selectedSummaryProvider
          : null,
      )
      .toBe('OpenAi');

    await expect(page.getByText(/are sent to OpenAI to get an answer/)).toBeVisible();
    const key = page.getByLabel('API key', { exact: true }).and(page.locator('input'));
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(SECRET);
    await page.getByRole('button', { name: 'Save key' }).click();

    await expect(page.getByTestId('TxtApiKeyStatus')).toHaveText('Key saved.');
    await expect(
      page.getByText('Key saved. It is encrypted on this PC and never shown again.'),
    ).toBeVisible();
    await expect(key).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Remove key' })).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);
    expect(fs.readFileSync(settingsFile, 'utf8')).not.toContain(SECRET);

    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('TxtApiKeyStatus')).toHaveText(
      'Verified. 2 models are listed under Model.',
    );
    // The saved model fills the field, yet opening the picker lists every suggestion.
    const modelField = page.getByRole('combobox', { name: 'Model' });
    await expect(modelField).toHaveValue('gpt-6-astra');
    await modelField.click();
    const modelList = page.getByTestId('ListApiModels');
    await expect(modelList.getByRole('option')).toHaveCount(6);
    await expect(modelList.getByRole('option', { name: /GPT-6 Astra/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modelList).toBeHidden();

    expect(await seriousViolations(page)).toEqual([]);
  } finally {
    await launched.close();
  }
});
