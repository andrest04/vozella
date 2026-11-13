import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';

// The summary provider section of Settings (S20) in the real window, on the fake native build and
// a throwaway data root. No real CLI, model or network is involved. Screenshots go to
// docs/port/screens/summaries/settings-*.png and are rewritten only with VOZELLA_SCREENSHOTS=1.

test.describe.configure({ timeout: 90_000 });

const shots = path.resolve(__dirname, '../../../docs/port/screens/summaries');
const capture = process.env.VOZELLA_SCREENSHOTS === '1';

interface Session {
  readonly launched: LaunchedApp;
  readonly page: Page;
  readonly file: string;
  readonly settings: () => Record<string, unknown>;
}

async function start(seedSettings?: object): Promise<Session> {
  const launched = await launchApp({ VOZELLA_E2E_SHOW: '1' }, (root) => {
    if (!seedSettings) return;
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'settings.json'), JSON.stringify(seedSettings));
  });
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1120, 1000);
  });
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  const file = path.join(launched.dataRoot, 'app', 'settings.json');
  return {
    launched,
    page,
    file,
    settings: () =>
      fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
        : {},
  };
}

async function seeProvider(page: Page, heading = 'Summary provider'): Promise<void> {
  await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
}

async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('vozella.theme', value);
  }, theme);
  await page.reload();
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await seeProvider(page);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!capture) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function seriousViolations(page: Page): Promise<unknown[]> {
  // A closing select popup is still in the document for a moment; audit the settled page.
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.waitForTimeout(400);
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

/** The engine list's rows: one disclosure button per engine, in display order. */
function engineRows(page: Page, name = 'Choose where summaries are generated') {
  return page.getByRole('group', { name }).locator('button[aria-expanded]');
}

async function pick(page: Page, select: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: select }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('the engine rows are Local, Claude Code, Codex and the API key engines, and Use this engine saves the enum name (172)', async () => {
  const s = await start();
  try {
    await seeProvider(s.page);
    const rows = engineRows(s.page);
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(0)).toHaveAccessibleName('Local (on this device)');
    await expect(rows.nth(1)).toHaveAccessibleName('Claude Code CLI');
    await expect(rows.nth(2)).toHaveAccessibleName('Codex CLI');
    await expect(rows.nth(3)).toHaveAccessibleName('OpenAI');
    await expect(rows.nth(0)).toHaveAccessibleDescription(/In use/);
    await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
    expect(fs.existsSync(s.file)).toBe(false);

    // Opening a row never switches engines; a CLI that is not on the PATH cannot be used yet.
    await rows.nth(2).click();
    await expect(s.page.getByText('Not found on PATH', { exact: false })).toBeVisible();
    await expect(s.page.getByText('Install Codex, then check again.')).toBeVisible();
    await expect(s.page.getByRole('button', { name: 'Use this engine' })).toHaveCount(0);
    expect(fs.existsSync(s.file)).toBe(false);

    await rows.nth(1).click();
    await expect(s.page.getByText('Detected on PATH.')).toBeVisible();
    await s.page.getByRole('button', { name: 'Use this engine' }).click();
    await expect.poll(() => s.settings().selectedSummaryProvider).toBe('ClaudeCode');
    await expect(rows.nth(1)).toHaveAccessibleDescription(/In use/);
  } finally {
    await s.launched.close();
  }
});

test('a settings file that names Grok shows the notice, selects nothing and changes nothing (S07, 172)', async () => {
  const seedFile = {
    selectedSummaryProvider: 'Xai',
    selectedXaiModelId: 'grok-4.6',
    selectedXaiEffort: 'low',
    typeSafeEnabled: true,
  };
  const s = await start(seedFile);
  try {
    await seeProvider(s.page);
    const notice =
      'Grok (xAI) is no longer available. Pick Local, Claude Code, Codex or an API key engine to summarize your meetings.';
    await expect(s.page.getByText(notice)).toBeVisible();
    const rows = engineRows(s.page);
    await expect(rows).toHaveCount(7);
    for (const row of await rows.all()) {
      await expect(row).not.toHaveAccessibleDescription(/In use/);
      await expect(row).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(s.page.getByRole('button', { name: /Grok/ })).toHaveCount(0);
    // Opening the page wrote nothing.
    expect(s.settings()).toEqual(seedFile);

    await s.page.getByRole('button', { name: 'Claude Code CLI' }).click();
    await s.page.getByRole('button', { name: 'Use this engine' }).click();
    await expect(s.page.getByText(notice)).toBeHidden();
    await expect
      .poll(() => s.settings())
      .toMatchObject({
        selectedSummaryProvider: 'ClaudeCode',
        selectedXaiModelId: 'grok-4.6',
        typeSafeEnabled: true,
      });
  } finally {
    await s.launched.close();
  }
});

test('Claude Code model and effort save one field at a time with a 4 second toast (173 to 175)', async () => {
  const s = await start({ selectedSummaryProvider: 'ClaudeCode' });
  try {
    await seeProvider(s.page);
    await expect(s.page.getByText('Detected on PATH.')).toBeVisible();
    await expect(s.page.getByRole('combobox', { name: 'Model' })).toContainText('sonnet');
    await expect(s.page.getByRole('combobox', { name: 'Effort' })).toContainText('low');

    await pick(s.page, 'Model', 'opus');
    const toast = s.page.getByText('Saved. Using opus · low.');
    await expect(toast).toBeVisible();
    const shownAt = Date.now();
    await expect.poll(() => s.settings().selectedClaudeModelId).toBe('opus');
    expect(s.settings().selectedClaudeEffort ?? 'low').toBe('low');
    await expect(toast).toBeHidden({ timeout: 8000 });
    expect(Date.now() - shownAt).toBeGreaterThan(2500);

    await pick(s.page, 'Effort', 'max');
    await expect(s.page.getByText('Saved. Using opus · max.')).toBeVisible();
    await expect.poll(() => s.settings().selectedClaudeEffort).toBe('max');
  } finally {
    await s.launched.close();
  }
});

test('Codex has its own catalog and defaults', async () => {
  const s = await start({ selectedSummaryProvider: 'Codex' });
  try {
    await seeProvider(s.page);
    await expect(s.page.getByRole('combobox', { name: 'Model' })).toContainText('gpt-5.6');
    await s.page.getByRole('combobox', { name: 'Effort' }).click();
    await expect(s.page.getByRole('option')).toHaveText(['low', 'medium', 'high', 'xhigh']);
    await s.page.getByRole('option', { name: 'xhigh', exact: true }).click();
    await expect(s.page.getByText('Saved. Using gpt-5.6 · xhigh.')).toBeVisible();
    await expect.poll(() => s.settings().selectedCodexEffort).toBe('xhigh');
  } finally {
    await s.launched.close();
  }
});

test('Set up opens the wizard on the hardware step and Cancel leaves nothing saved', async () => {
  const s = await start();
  try {
    await seeProvider(s.page);
    await s.page.getByRole('button', { name: 'Set up' }).click();
    const dialog = s.page.getByRole('dialog', { name: 'Set up summary generation' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Choose a model to generate summaries')).toBeVisible();
    await expect(dialog.getByText('Choose how to generate summaries')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(dialog).toBeHidden();
    await expect(s.page.getByRole('button', { name: 'Set up' })).toBeVisible();
    expect(s.settings().selectedSummaryModelId ?? null).toBeNull();
  } finally {
    await s.launched.close();
  }
});

test('downloading a model in the wizard makes it active and the Set up button goes away', async () => {
  const s = await start();
  try {
    await seeProvider(s.page);
    await s.page.getByRole('button', { name: 'Set up' }).click();
    const dialog = s.page.getByRole('dialog', { name: 'Set up summary generation' });
    await expect(dialog.getByText('Choose a model to generate summaries')).toBeVisible();
    await dialog.getByRole('button', { name: 'Download and use this model' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => s.settings().selectedSummaryModelId).toBeTruthy();
    await expect(s.page.getByRole('button', { name: 'Set up' })).toHaveCount(0);
    // The Local row now names the active model and offers the full list behind Change model.
    await expect(s.page.getByRole('button', { name: 'Change model' })).toBeVisible();
    await s.page.getByRole('button', { name: 'Change model' }).click();
    const models = s.page.getByRole('dialog', { name: 'Summary models' });
    await expect(models.getByText('Active', { exact: true })).toBeVisible();
  } finally {
    await s.launched.close();
  }
});

test('Spanish: engine rows, notice and toast use the Spanish catalog', async () => {
  const s = await start({ uiLanguage: 'es', selectedSummaryProvider: 'Xai' });
  try {
    await seeProvider(s.page, 'Proveedor de resumen');
    await expect(
      s.page.getByText(
        'Grok (xAI) ya no está disponible. Elige Local, Claude Code, Codex o un motor con clave de API para resumir tus reuniones.',
      ),
    ).toBeVisible();
    const rows = engineRows(s.page, 'Elige dónde se generan los resúmenes');
    await expect(rows.nth(0)).toHaveAccessibleName('Local (en este dispositivo)');
    await expect(rows.nth(1)).toHaveAccessibleName('CLI de Claude Code');
    await expect(rows.nth(2)).toHaveAccessibleName('CLI de Codex');
    await rows.nth(1).click();
    await pick(s.page, 'Modelo', 'haiku');
    await expect(s.page.getByText('Guardado. Usando haiku · low.')).toBeVisible();
    await shot(s.page, 'settings-claude-es');
  } finally {
    await s.launched.close();
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`screens and axe in ${theme}`, async () => {
    const s = await start({ selectedSummaryProvider: 'Xai' });
    try {
      await seeProvider(s.page);
      await useTheme(s.page, theme);
      await expect(s.page.getByText(/no longer available/)).toBeVisible();
      await shot(s.page, `settings-grok-notice-${theme}`);
      expect(await seriousViolations(s.page)).toEqual([]);

      await s.page.getByRole('button', { name: 'Local (on this device)' }).click();
      await expect(s.page.getByRole('button', { name: 'Set up' })).toBeVisible();
      await shot(s.page, `settings-local-setup-${theme}`);
      expect(await seriousViolations(s.page)).toEqual([]);

      await s.page.getByRole('button', { name: 'Claude Code CLI' }).click();
      await pick(s.page, 'Model', 'opus');
      await expect(s.page.getByText('Saved. Using opus · low.')).toBeVisible();
      await shot(s.page, `settings-claude-saved-${theme}`);
      expect(await seriousViolations(s.page)).toEqual([]);

      await s.page.getByRole('button', { name: 'Local (on this device)' }).click();
      await s.page.getByRole('button', { name: 'Set up' }).click();
      await expect(s.page.getByText('Choose a model to generate summaries')).toBeVisible();
      await shot(s.page, `settings-wizard-${theme}`);
      expect(await seriousViolations(s.page)).toEqual([]);
    } finally {
      await s.launched.close();
    }
  });
}
