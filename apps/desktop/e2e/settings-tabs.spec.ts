import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import {
  launchApp,
  openSettingsTab,
  type LaunchedApp,
  type SettingsTab,
  setMainContentSize,
} from './launch';

// The four tabs of the Settings page in the real window, on the fake native build and a throwaway
// data root: what each one holds, the keyboard, the remembered tab, the sticky list, and how the
// tabs look in both themes and both languages. The pictures go to the test output folder.

const TABS: readonly SettingsTab[] = ['recording', 'transcription', 'summary', 'general'];

const COPY = {
  en: {
    settings: 'Settings',
    library: 'Library',
    list: 'Settings sections',
    labels: ['Recording', 'Transcription', 'Summaries & AI', 'General'],
    sections: [
      ['Microphone', 'Call detection'],
      ['Meeting language', 'Transcription'],
      ['Summary provider'],
      ['Appearance', 'Language', 'Startup', 'Data', 'About'],
    ],
  },
  es: {
    settings: 'Configuración',
    library: 'Biblioteca',
    list: 'Secciones de configuración',
    labels: ['Grabación', 'Transcripción', 'Resumen e IA', 'General'],
    sections: null,
  },
} as const;

type Locale = keyof typeof COPY;

/** The most the page scrollbar takes from the content column, in px. */
const SCROLLBAR = 12;

async function openApp(locale: Locale): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchApp({}, (root) => {
    if (locale === 'en') return;
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'app', 'settings.json'),
      JSON.stringify({ uiLanguage: locale }),
    );
  });
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await setMainContentSize(launched.app, 1120, 800);
  await page.getByRole('navigation').getByRole('link', { name: COPY[locale].settings }).click();
  await expect(page.getByRole('tablist', { name: COPY[locale].list })).toBeVisible();
  return { launched, page };
}

/** The section headings on screen. It waits: the panel being left stays until the next frame. */
const expectSections = (page: Page, wanted: readonly string[] | undefined): Promise<void> =>
  expect(
    page.locator('[role="tabpanel"]:not([inert])').getByRole('heading', { level: 2 }),
  ).toHaveText([...(wanted ?? [])]);

/** Axe and the pictures read computed styles, so every finite transition ends first. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
    }
  });
}

async function seriousViolations(page: Page): Promise<unknown[]> {
  await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const runner = (
      window as unknown as {
        axe: { run: () => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    const result = await runner.run();
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  });
}

/** Every tab in one theme: the label fits, the underline is under it, nothing jumps, axe is clean. */
async function checkLook(page: Page, locale: Locale, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('vozella.theme', value);
  }, theme);
  await page.reload();
  const list = page.getByRole('tablist', { name: COPY[locale].list });
  await expect(list).toBeVisible();
  const listBox = await list.boundingBox();
  if (!listBox) throw new Error('expected the tab list');

  for (const [index, id] of TABS.entries()) {
    await openSettingsTab(page, id);
    await settle(page);
    const tab = page.getByTestId(`SettingsTab-${id}`);
    await expect(tab).toHaveText(COPY[locale].labels[index] ?? '');

    // The list never moves between tabs, and no label wraps or is cut. Its right edge may give
    // way to the page scrollbar, which a tab taller than the window brings in.
    const box = await list.boundingBox();
    expect(box).toMatchObject({ x: listBox.x, y: listBox.y, height: listBox.height });
    expect(listBox.width - (box?.width ?? 0)).toBeLessThanOrEqual(SCROLLBAR);
    expect(listBox.width - (box?.width ?? 0)).toBeGreaterThanOrEqual(0);
    const fit = await list.evaluate((node) => ({
      overflow: node.scrollWidth - node.clientWidth,
      heights: [...node.querySelectorAll('[role="tab"]')].map(
        (item) => item.getBoundingClientRect().height,
      ),
    }));
    expect(fit.overflow).toBeLessThanOrEqual(0);
    // One line each: the 36px tab of DESIGN.md, in rem on the app's 14px root.
    expect(fit.heights).toEqual([31.5, 31.5, 31.5, 31.5]);

    // The ink underline sits under the selected tab.
    const tabBox = await tab.boundingBox();
    const underline = await list.locator(':scope > :not([role="tab"])').boundingBox();
    if (!tabBox || !underline) throw new Error('expected the tab and its underline');
    expect(underline.x).toBeCloseTo(tabBox.x, 0);
    expect(underline.width).toBeCloseTo(tabBox.width, 0);
    // It rests on the list's hairline.
    expect(listBox.y + listBox.height - (underline.y + underline.height)).toBeCloseTo(1, 0);

    await page.screenshot({
      path: test.info().outputPath(`settings-${id}-${theme}-${locale}.png`),
    });
    expect(await seriousViolations(page), `${id} in ${theme}`).toEqual([]);
  }
}

test.describe('Settings tabs', () => {
  let launched: LaunchedApp;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    ({ launched, page } = await openApp('en'));
  });

  test.afterAll(async () => {
    await launched.close();
  });

  test('the page opens on Recording, and each tab shows only its sections', async () => {
    const tabs = page.getByRole('tablist', { name: COPY.en.list }).getByRole('tab');
    await expect(tabs).toHaveText([...COPY.en.labels]);
    await expect(page.getByTestId('SettingsTab-recording')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectSections(page, COPY.en.sections[0]);

    for (const [index, id] of TABS.entries()) {
      await openSettingsTab(page, id);
      await expectSections(page, COPY.en.sections[index]);
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  test('the arrow keys move between tabs, and the panel is the next tab stop', async () => {
    await openSettingsTab(page, 'recording');
    await page.getByTestId('SettingsTab-recording').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('SettingsTab-transcription')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('SettingsTab-transcription')).toBeFocused();
    await expectSections(page, COPY.en.sections[1]);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('SettingsTab-recording')).toBeFocused();
    // One Tab leaves the list: the tabs are a single stop, and the panel follows them.
    await page.keyboard.press('Tab');
    await expect(page.locator('[role="tabpanel"]:not([inert])')).toBeFocused();
  });

  test('a revisit opens the tab the page was left on', async () => {
    await openSettingsTab(page, 'general');
    await page.getByRole('navigation').getByRole('link', { name: COPY.en.library }).click();
    await expect(page.getByRole('tablist', { name: COPY.en.list })).toHaveCount(0);
    await page.getByRole('navigation').getByRole('link', { name: COPY.en.settings }).click();
    await expect(page.getByTestId('SettingsTab-general')).toHaveAttribute('aria-selected', 'true');
    await expectSections(page, COPY.en.sections[3]);
  });

  test('the tab list stays at the top of a long tab, and a focused control clears it', async () => {
    await setMainContentSize(launched.app, 1120, 420);
    await openSettingsTab(page, 'summary');
    const list = page.getByRole('tablist', { name: COPY.en.list });
    const main = page.locator('main#content');
    const mainTop = (await main.boundingBox())?.y ?? Number.NaN;
    await expect
      .poll(() => main.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(150);

    await main.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect.poll(async () => (await list.boundingBox())?.y).toBeCloseTo(mainTop, 0);
    await page.screenshot({ path: test.info().outputPath('settings-summary-scrolled.png') });

    // Focus brings the first engine row back from under the list, not behind it (WCAG 2.4.11).
    const first = page
      .getByRole('group', { name: 'Choose where summaries are generated' })
      .locator('li > button[aria-expanded]')
      .first();
    await first.focus();
    const listBox = await list.boundingBox();
    const firstBox = await first.boundingBox();
    if (!listBox || !firstBox) throw new Error('expected the list and the first row');
    expect(firstBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);

    await setMainContentSize(launched.app, 1120, 800);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`every tab fits, lines up and passes axe in ${theme}`, async () => {
      await checkLook(page, 'en', theme);
    });
  }
});

test.describe('Settings tabs in Spanish', () => {
  let launched: LaunchedApp;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    ({ launched, page } = await openApp('es'));
  });

  test.afterAll(async () => {
    await launched.close();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`every tab fits, lines up and passes axe in ${theme}`, async () => {
      await checkLook(page, 'es', theme);
    });
  }
});
