import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';
import { writeMeeting } from './library-data';

// Page widths on a wide window: Settings, Record and the meeting page fill the content area up
// to the 1152 px page cap, centered; the summary keeps a 900 px reading measure, left-aligned.
// A narrow window keeps the old behaviour: full width, same padding, no horizontal scroll.

test.describe.configure({ timeout: 120_000, mode: 'serial' });

const MEETING = '7d2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c11';
const PAGE_MAX = 1152;
const READING_MAX = 900;

const SUMMARY = [
  '### What this was',
  '',
  'Weekly check-in on the September release, with three decisions and one open risk. '.repeat(6),
  '',
  '### Key points',
  '',
  '- The build is green again after the dependency pin.',
  '- Export to CSV moves to the next sprint.',
].join('\n');

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({ VOZELLA_E2E_SHOW: '1' }, (dataRoot) => {
    writeMeeting(path.join(dataRoot, 'meetings'), {
      id: MEETING,
      title: 'Weekly sync',
      recordedAt: '2026-09-08T09:00:00.0000000+00:00',
      transcript: '[00:00.00-00:05.00] Ana: we ship on Friday',
      summary: SUMMARY,
    });
  });
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
});

test.afterAll(async () => {
  await launched.close();
});

async function resize(width: number, height: number): Promise<void> {
  await launched.app.evaluate(
    ({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (main?.isMaximized()) main.unmaximize();
      main?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(width - 8);
}

async function go(hash: string): Promise<void> {
  await page.evaluate((value) => {
    window.location.hash = value;
  }, hash);
}

interface Box {
  readonly left: number;
  readonly width: number;
  /** Horizontal padding on each side. */
  readonly padding: number;
}

/**
 * The shell's page column (padding included) and the area it sits in: the scroller's client
 * box, so a vertical scrollbar does not count as space beside the column.
 */
async function columnBoxes(): Promise<{ column: Box; main: Box }> {
  return page.evaluate(() => {
    const main = document.getElementById('content');
    const column = main?.firstElementChild;
    if (!main || !column) throw new Error('missing content column');
    const rect = column.getBoundingClientRect();
    return {
      column: {
        left: rect.left,
        width: rect.width,
        padding: parseFloat(getComputedStyle(column).paddingLeft),
      },
      main: {
        left: main.getBoundingClientRect().left + main.clientLeft,
        width: main.clientWidth,
        padding: 0,
      },
    };
  });
}

async function expectWideColumn(): Promise<Box> {
  const { column, main } = await columnBoxes();
  const where = `column ${String(column.width)} in an area of ${String(main.width)}`;
  expect(column.width - 2 * column.padding, where).toBeCloseTo(PAGE_MAX, 0);
  // Centered in the content area: the same space on both sides, within a pixel of rounding.
  const left = column.left - main.left;
  const right = main.left + main.width - (column.left + column.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  return column;
}

async function expectNoHorizontalScroll(): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll).toBe(client);
}

test('on a 1920 px window Settings and Record fill the page column up to 1152 px', async () => {
  await resize(1920, 1080);
  await go('#/settings');
  await expect(page.getByRole('radio', { name: /dark|oscuro/i })).toBeVisible();
  await expectWideColumn();
  await expectNoHorizontalScroll();
  await page.screenshot({ path: test.info().outputPath('settings-1920.png') });

  await go('#/record');
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  const column = await expectWideColumn();
  const idle = await page.getByTestId('record-idle').boundingBox();
  if (!idle) throw new Error('expected the idle block');
  expect(idle.width).toBeCloseTo(column.width - 2 * column.padding, 0);
  await expectNoHorizontalScroll();
  await page.screenshot({ path: test.info().outputPath('record-1920.png') });
});

test('on a 1920 px window the meeting page is wide and the summary keeps the reading measure', async () => {
  await resize(1920, 1080);
  await page.evaluate(async (id) => {
    await window.vozella.invoke('workspace.dispatch', { action: { type: 'selectMeeting', id } });
    await window.vozella.invoke('workspace.dispatch', {
      action: { type: 'openSession', tab: 'Summary' },
    });
  }, MEETING);
  await expect(page.getByRole('heading', { name: 'Key points' })).toBeVisible();
  const column = await expectWideColumn();
  const tabs = await page.getByTestId('SelectorSessionTabs').boundingBox();
  const summary = await page.getByTestId('TxtSummaryContent').boundingBox();
  if (!tabs || !summary) throw new Error('expected tabs and summary');
  expect(tabs.width).toBeCloseTo(column.width - 2 * column.padding, 0);
  expect(summary.width).toBeLessThanOrEqual(READING_MAX + 0.5);
  // Left-aligned with the page column, not centered in it.
  expect(summary.x).toBeCloseTo(column.left + column.padding, 0);
  await expectNoHorizontalScroll();
  await page.screenshot({ path: test.info().outputPath('session-summary-1920.png') });

  await page.getByRole('tab', { name: 'Transcript' }).click();
  const transcript = page.getByTestId('TxtTranscriptContent');
  // The tab slides in from the side; measure once it has settled.
  await expect
    .poll(async () => (await transcript.boundingBox())?.x)
    .toBeCloseTo(column.left + column.padding, 0);
  const box = await transcript.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(READING_MAX + 0.5);
});

test('on a narrow window the column is full width with the same padding', async () => {
  await resize(960, 700);
  for (const hash of ['#/settings', '#/record', '#/session']) {
    await go(hash);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    const { column, main } = await columnBoxes();
    expect(column.left).toBeCloseTo(main.left, 0);
    expect(column.width).toBeLessThanOrEqual(main.width + 0.5);
    expect(column.width).toBeLessThan(PAGE_MAX + 2 * column.padding);
    await expectNoHorizontalScroll();
  }
});
