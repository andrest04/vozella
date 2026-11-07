import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';
import { writeMeeting } from './library-data';

// Action item deadlines on the Summary tab, in the real app with a seeded throwaway library:
// the detail line (owner · date · "quote"), the "when is the next session?" prompt, inline date
// edits and the `.ics` export through a stubbed save dialog. Files on disk are the truth.

test.describe.configure({ timeout: 150_000 });

const REVIEW = '6c2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c10';
const EDIT = '7d2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c11';
const EXPORT = '8e2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c12';
const NONE = '9f2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c13';
const SPANISH = 'a02b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c14';

// Tuesday, 8 September 2026: anything on or before that day is not a "next session".
const RECORDED_AT = '2026-09-08T09:00:00.0000000+00:00';

interface SeedItem {
  readonly text: string;
  readonly done?: boolean;
  readonly owner?: string;
  readonly deadline?: { readonly quote: string; readonly kind: string; readonly date?: string };
}

const BRING = {
  text: 'Bring the parser progress',
  deadline: { quote: 'para la siguiente clase', kind: 'next_meeting' },
};
const SLIDES = {
  text: 'Send the slides to the group',
  owner: 'Ana',
  deadline: { quote: 'el viernes', kind: 'weekday:fri', date: '2026-09-11' },
};
const LAB = { text: 'Book the lab' };
const HANDOUTS = {
  text: 'Print the handouts',
  done: true,
  deadline: { quote: 'el jueves', kind: 'weekday:thu', date: '2026-09-10' },
};

/** A meeting file with `## Action Items` and, index by index, its `## Action Item Data`. */
function seedMeeting(root: string, id: string, title: string, items: readonly SeedItem[]): void {
  const file = writeMeeting(root, {
    id,
    title,
    recordedAt: RECORDED_AT,
    transcript: '[00:00.00-00:05.00] Ana: para la siguiente clase traigan el avance',
    summary: `Class notes for ${title}.`,
  });
  const lines = items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`);
  const data = items.map((item) =>
    item.owner === undefined && item.deadline === undefined
      ? null
      : {
          text: item.text,
          ...(item.owner === undefined ? {} : { owner: item.owner }),
          ...(item.deadline === undefined ? {} : { deadline: item.deadline }),
        },
  );
  fs.appendFileSync(
    file,
    [
      '',
      '## Action Items',
      '',
      ...lines,
      '',
      '## Action Item Data',
      '',
      JSON.stringify(data),
      '',
    ].join('\n'),
    'utf8',
  );
}

function seed(dataRoot: string): void {
  const root = path.join(dataRoot, 'meetings');
  seedMeeting(root, REVIEW, 'Compilers class', [BRING, SLIDES, LAB]);
  seedMeeting(root, EDIT, 'Design review', [SLIDES, LAB]);
  seedMeeting(root, EXPORT, 'Databases class', [
    { ...BRING, deadline: { ...BRING.deadline, date: '2026-09-15' } },
    SLIDES,
    LAB,
    HANDOUTS,
  ]);
  seedMeeting(root, NONE, 'Quick sync', [LAB, HANDOUTS]);
  seedMeeting(root, SPANISH, 'Clase de redes', [BRING, LAB]);
}

/** The markdown file that holds a meeting, found by its id. */
function fileOf(dataRoot: string, id: string): string {
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : entry.name.endsWith('.md')
            ? [path.join(dir, entry.name)]
            : [],
      );
  const found = walk(path.join(dataRoot, 'meetings')).find((file) =>
    fs.readFileSync(file, 'utf8').includes(`id: ${id}`),
  );
  if (!found) throw new Error(`no file for ${id}`);
  return found;
}

/** The saved `## Action Item Data` entries of a meeting. */
function savedData(dataRoot: string, id: string): unknown[] {
  const text = fs.readFileSync(fileOf(dataRoot, id), 'utf8');
  const match = /## Action Item Data\s+(\[.*\])/.exec(text);
  return match ? (JSON.parse(match[1] ?? '[]') as unknown[]) : [];
}

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({ VOZELLA_E2E_SHOW: '1' }, seed);
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1120, 780);
  });
});

test.afterAll(async () => {
  await launched.close();
});

const openSummary = async (id: string): Promise<void> => {
  await page.evaluate(async (meeting) => {
    await window.vozella.invoke('workspace.dispatch', {
      action: { type: 'selectMeeting', id: meeting },
    });
    await window.vozella.invoke('workspace.dispatch', {
      action: { type: 'openSession', tab: 'Summary' },
    });
  }, id);
  await expect(page).toHaveURL(/#\/session$/);
  await expect(page.getByTestId('ListActionItems')).toBeVisible();
};

const item = (text: string): Locator =>
  page.getByTestId('ListActionItems').getByRole('listitem').filter({ hasText: text });

/** Replaces the main-process save dialog; every call is counted for the cancelled case. */
const stubSaveDialog = async (answer: { canceled: boolean; filePath?: string }): Promise<void> => {
  await launched.app.evaluate(({ dialog }, result) => {
    const counter = globalThis as unknown as { icsDialogCalls?: number };
    counter.icsDialogCalls = 0;
    dialog.showSaveDialog = () => {
      counter.icsDialogCalls = (counter.icsDialogCalls ?? 0) + 1;
      return Promise.resolve({ canceled: result.canceled, filePath: result.filePath ?? '' });
    };
  }, answer);
};

const dialogCalls = (): Promise<number> =>
  launched.app.evaluate(
    () => (globalThis as unknown as { icsDialogCalls?: number }).icsDialogCalls ?? 0,
  );

test('each item shows who, when and the words behind the date; a plain item shows none', async () => {
  await openSummary(REVIEW);
  const slides = item(SLIDES.text).getByTestId('ActionItemMeta');
  await expect(slides).toContainText('Ana');
  await expect(slides).toContainText('“el viernes”');
  await expect(slides.getByTestId('BtnActionItemDate')).toHaveAccessibleName(
    /^Change the date, .*11/,
  );
  await expect(slides.getByTestId('BtnClearActionItemDate')).toBeVisible();

  // "Next class" never becomes an invented date: the quote is there, the date is not.
  const bring = item(BRING.text).getByTestId('ActionItemMeta');
  await expect(bring).toContainText('“para la siguiente clase”');
  await expect(bring.getByTestId('BtnActionItemDate')).toHaveText('Add date');
  await expect(bring.getByTestId('BtnClearActionItemDate')).toHaveCount(0);

  await expect(item(LAB.text)).toBeVisible();
  await expect(item(LAB.text).getByTestId('ActionItemMeta')).toHaveCount(0);
});

test('the next-session prompt rejects a past day, fills the waiting item and is remembered', async () => {
  await openSummary(REVIEW);
  const prompt = page.getByTestId('NextSessionPrompt');
  await expect(prompt).toContainText('When is the next session?');
  await expect(prompt).toContainText('Compilers class');
  const save = prompt.getByTestId('BtnSaveNextSession');
  await expect(save).toBeDisabled();

  await prompt.getByTestId('DateNextSession').fill('2026-09-08');
  await save.click();
  await expect(prompt).toContainText('Pick a date after this meeting.');
  expect(savedData(launched.dataRoot, REVIEW)[0]).toMatchObject({
    deadline: { kind: 'next_meeting' },
  });
  expect(savedData(launched.dataRoot, REVIEW)[0]).not.toHaveProperty('deadline.date');

  await prompt.getByTestId('DateNextSession').fill('2026-09-15');
  await expect(prompt).not.toContainText('Pick a date after this meeting.');
  await save.click();
  await expect(prompt).toBeHidden();
  const bring = item(BRING.text).getByTestId('ActionItemMeta');
  await expect(bring.getByTestId('BtnActionItemDate')).toHaveAccessibleName(
    /^Change the date, .*15/,
  );
  await expect
    .poll(() => savedData(launched.dataRoot, REVIEW)[0])
    .toMatchObject({ deadline: { kind: 'next_meeting', date: '2026-09-15' } });
  const settings = JSON.parse(
    fs.readFileSync(path.join(launched.dataRoot, 'app', 'settings.json'), 'utf8'),
  ) as { nextSessionDates?: Record<string, string> };
  expect(settings.nextSessionDates).toMatchObject({ 'compilers class': '2026-09-15' });

  // Reopened from another meeting: the date comes back from the file and nothing asks again.
  await openSummary(NONE);
  await openSummary(REVIEW);
  await expect(item(BRING.text).getByTestId('BtnActionItemDate')).toHaveAccessibleName(
    /^Change the date, .*15/,
  );
  await expect(page.getByTestId('NextSessionPrompt')).toHaveCount(0);
});

test('a date is edited inline and cleared, and both are written to the file', async () => {
  await openSummary(EDIT);
  const meta = item(SLIDES.text).getByTestId('ActionItemMeta');
  await meta.getByTestId('BtnActionItemDate').click();
  const field = meta.getByTestId('DateActionItem');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('2026-09-11');
  await field.fill('2026-09-18');
  await field.press('Enter');
  await expect(field).toBeHidden();
  await expect(meta.getByTestId('BtnActionItemDate')).toHaveAccessibleName(
    /^Change the date, .*18/,
  );
  await expect(meta.getByTestId('BtnActionItemDate')).toBeFocused();
  await expect
    .poll(() => savedData(launched.dataRoot, EDIT)[0])
    .toMatchObject({ owner: 'Ana', deadline: { quote: 'el viernes', date: '2026-09-18' } });

  // Escape keeps the old date.
  await meta.getByTestId('BtnActionItemDate').click();
  await meta.getByTestId('DateActionItem').fill('2026-09-25');
  await meta.getByTestId('DateActionItem').press('Escape');
  await expect(meta.getByTestId('BtnActionItemDate')).toHaveAccessibleName(
    /^Change the date, .*18/,
  );

  await meta.getByTestId('BtnClearActionItemDate').click();
  await expect(meta.getByTestId('BtnActionItemDate')).toHaveText('Add date');
  await expect(meta).toContainText('“el viernes”');
  await expect
    .poll(() => savedData(launched.dataRoot, EDIT)[0])
    .not.toHaveProperty('deadline.date');
  expect(savedData(launched.dataRoot, EDIT)[0]).toMatchObject({
    deadline: { quote: 'el viernes' },
  });
  // With no open dated item left, there is nothing to export.
  await expect(page.getByTestId('BtnExportIcs')).toBeDisabled();
});

test('a cancelled save dialog writes nothing and says nothing', async () => {
  await openSummary(EXPORT);
  await stubSaveDialog({ canceled: true });
  const button = page.getByTestId('BtnExportIcs');
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(dialogCalls).toBe(1);
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('DraftMessage')).toHaveCount(0);
});

test('the export writes one all-day event per open dated item', async () => {
  await openSummary(EXPORT);
  const target = path.join(launched.dataRoot, 'exports', 'databases.ics');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await stubSaveDialog({ canceled: false, filePath: target });
  await page.getByTestId('BtnExportIcs').click();
  await expect(page.getByTestId('DraftMessage')).toContainText(
    '2 action items saved to the calendar file.',
  );
  expect(await dialogCalls()).toBe(1);

  const ics = fs.readFileSync(target, 'utf8');
  expect(ics).toContain('BEGIN:VCALENDAR');
  expect(ics).toContain('END:VCALENDAR');
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  const starts = [...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]).sort();
  expect(starts).toEqual(['20260911', '20260915']);
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  expect(unfolded).toContain(BRING.text);
  expect(unfolded).toContain(SLIDES.text);
  // Done and undated items stay out.
  expect(unfolded).not.toContain(HANDOUTS.text);
  expect(unfolded).not.toContain(LAB.text);
});

test('the export button is disabled when no open item has a date', async () => {
  await openSummary(NONE);
  const button = page.getByTestId('BtnExportIcs');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(
    'Set a date on an open item to add it to your calendar.',
  );
});

test('in Spanish the prompt, the dates and the export use the Spanish strings', async () => {
  await openSummary(SPANISH);
  await page.evaluate(() => window.vozella.invoke('settings.setUiLanguage', { tag: 'es' }));
  try {
    const prompt = page.getByTestId('NextSessionPrompt');
    await expect(prompt).toContainText('¿Cuándo es la próxima sesión?');
    await expect(prompt.getByTestId('BtnSaveNextSession')).toHaveText('Guardar');
    await prompt.getByTestId('DateNextSession').fill('2026-09-01');
    await prompt.getByTestId('BtnSaveNextSession').click();
    await expect(prompt).toContainText('Elige una fecha posterior a esta reunión.');
    await expect(item(BRING.text).getByTestId('BtnActionItemDate')).toHaveText('Agregar fecha');
    await expect(page.getByTestId('BtnExportIcs')).toHaveText('Agregar al calendario (.ics)');
    await expect(page.getByTestId('BtnExportIcs')).toBeDisabled();
  } finally {
    await page.evaluate(() => window.vozella.invoke('settings.setUiLanguage', { tag: 'en-US' }));
  }
  await expect(page.getByTestId('BtnExportIcs')).toHaveText('Add to calendar (.ics)');
});
