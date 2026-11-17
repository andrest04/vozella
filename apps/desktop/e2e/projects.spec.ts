import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axe from 'axe-core';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { FAKE_APPS } from './fake-audio-apps';
import { installEngine, launchAppInRoot, readyEnv } from './launch';
import {
  appDataOf,
  guid,
  libraryOf,
  minimalDocx,
  tinyPdf,
  writeLegacyFolders,
  writeMeeting,
  type LegacyFolderSeed,
} from './library-data';

// Projects end to end on the fake native build, every launch on its own throwaway data root: a
// legacy folder list becomes projects on the first launch (and never twice), a project is created,
// organized, given instructions and files, and starts a take; the model is given what the project
// holds; chats and meetings belong to a project and move between projects; a project is deleted
// with what it holds; the page adapts to its width; and it is accessible and in Spanish. Nothing
// touches a real Documents folder, a model or an account. Prompts are read from the fake engines'
// log files and the file picker is a double, as in chat-attachments.spec.ts.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const roots: string[] = [];
const projectDir = (root: string, projectId: string): string =>
  path.join(libraryOf(root), '.vozella', 'projects', projectId);
const backupsOf = (root: string): string[] => {
  const dir = path.join(libraryOf(root), '.vozella', 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const backupBytes = (root: string, name: string): Buffer =>
  fs.readFileSync(path.join(libraryOf(root), '.vozella', 'backups', name));

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-e2e-projects-'));
  roots.push(root);
  return root;
}

test.afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // A helper process of a closed app can hold a temp folder a moment.
    }
  }
});

interface Session {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly root: string;
}

async function open(root: string, env: Record<string, string> = {}): Promise<Session> {
  const app = await launchAppInRoot(root, { VOZELLA_E2E_SHOW: '1', ...env });
  const page = await app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  return { app, page, root };
}

/** Closes a session; a take still under way would ask before the window closes. */
async function end(session: Session): Promise<void> {
  await session.page
    .evaluate(() => window.vozella.invoke('recording.discard', {}))
    .catch(() => undefined);
  await session.app.close();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('link', { name, exact: true });

const goToProjects = async (page: Page): Promise<void> => {
  await nav(page, 'Projects').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
};

const goToLibrary = async (page: Page): Promise<void> => {
  await nav(page, 'Library').click();
  await expect(page.getByRole('grid', { name: 'Library' })).toBeVisible();
};

const cardLink = (page: Page, name: string) =>
  page.getByRole('article').getByRole('link', { name, exact: true });

const openProjectPage = async (page: Page, name: string): Promise<void> => {
  await goToProjects(page);
  await cardLink(page, name).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
};

const noProjectRow = (page: Page) => page.getByRole('link', { name: /^No project/ });

/** The titles of the project cards, in the order they are shown. */
const cardNames = (page: Page): Promise<string[]> =>
  page.getByRole('article').getByRole('heading', { level: 3 }).allInnerTexts();

/** A project through the app's own channel, for specs where creating it is not what is tested. */
async function createProject(
  page: Page,
  name: string,
  instructions = '',
  description = '',
): Promise<string> {
  const created = await page.evaluate(
    ([projectName, text]) =>
      window.vozella.invoke('projects.create', {
        name: projectName ?? '',
        description: text ?? '',
      }),
    [name, description],
  );
  if (!created.ok) throw new Error(`create failed: ${created.reason}`);
  if (instructions !== '') {
    const saved = await page.evaluate(
      ([projectId, text]) =>
        window.vozella.invoke('projects.setInstructions', {
          id: projectId ?? '',
          instructions: text ?? '',
        }),
      [created.project.id, instructions],
    );
    if (!saved.ok) throw new Error('instructions failed');
  }
  return created.project.id;
}

const pickNext = (app: ElectronApplication, files: readonly string[]) =>
  app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...paths] });
  }, files);

/** Sets the size of the window's content; the minimum is lowered so that the narrow layouts can be reached. */
const resize = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setMinimumSize(320, 320);
      win?.setContentSize(size.width, size.height);
    },
    { width, height },
  );

/** Settings for a Record page that can start at once; the fake engine is put on disk by `installEngine`. */
function seedReadyProvider(root: string): void {
  fs.mkdirSync(appDataOf(root), { recursive: true });
  fs.writeFileSync(
    path.join(appDataOf(root), 'settings.json'),
    JSON.stringify({
      selectedSummaryProvider: 'ClaudeCode',
      selectedSummaryModelId: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    }),
  );
}

/** Every file under a directory, relative and sorted: what "untouched" is compared by. */
function treeOf(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

const at = (n: number): string => `2026-09-0${String(n)}T10:00:00.0000000+00:00`;
/** After every project was last touched, so a meeting is the latest activity of its project. */
const later = (n: number): string => `2099-01-0${String(n)}T10:00:00.0000000+00:00`;

/** The older folder list: nesting, a name collision, a note, an orphan; and one meeting each. */
const LEGACY = {
  universidad: guid(1),
  calculoU: guid(2),
  trabajo: guid(3),
  calculoT: guid(4),
  producto: guid(5),
  huerfana: guid(6),
  unknown: guid(99),
} as const;

const LEGACY_FOLDERS: readonly LegacyFolderSeed[] = [
  { id: LEGACY.universidad, name: 'Universidad', parentId: null },
  { id: LEGACY.calculoU, name: 'Calculo', parentId: LEGACY.universidad },
  { id: LEGACY.trabajo, name: 'Trabajo', parentId: null },
  { id: LEGACY.calculoT, name: 'Calculo', parentId: LEGACY.trabajo },
  { id: LEGACY.producto, name: 'Producto Q4', parentId: null, note: 'Use a formal tone.' },
  { id: LEGACY.huerfana, name: 'Huerfana', parentId: guid(200) },
];

/** The meeting ids of the legacy library, by what they are called. */
const LEGACY_MEETINGS = {
  limits: guid(11),
  budget: guid(12),
  roadmap: guid(13),
  orphan: guid(14),
  standup: guid(15),
  lost: guid(16),
} as const;

function seedLegacyLibrary(root: string): Buffer {
  const library = libraryOf(root);
  const original = writeLegacyFolders(root, LEGACY_FOLDERS);
  writeMeeting(library, {
    id: LEGACY_MEETINGS.limits,
    title: 'Limits class',
    recordedAt: at(1),
    directory: 'Universidad/Calculo',
    projectId: LEGACY.calculoU,
  });
  writeMeeting(library, {
    id: LEGACY_MEETINGS.budget,
    title: 'Budget review',
    recordedAt: at(2),
    directory: 'Trabajo/Calculo',
    projectId: LEGACY.calculoT,
  });
  writeMeeting(library, {
    id: LEGACY_MEETINGS.roadmap,
    title: 'Roadmap sync',
    recordedAt: at(3),
    directory: 'Producto Q4',
    projectId: LEGACY.producto,
    summary: 'Agreed the roadmap.',
  });
  writeMeeting(library, {
    id: LEGACY_MEETINGS.orphan,
    title: 'Orphan notes',
    recordedAt: at(4),
    directory: 'Huerfana',
    projectId: LEGACY.huerfana,
  });
  writeMeeting(library, { id: LEGACY_MEETINGS.standup, title: 'Standup', recordedAt: at(5) });
  writeMeeting(library, {
    id: LEGACY_MEETINGS.lost,
    title: 'Lost folder',
    recordedAt: at(6),
    projectId: LEGACY.unknown,
  });
  return original;
}

/** Opens a meeting from the list the page is showing, and checks it is the one that opened. */
async function openMeetingFromList(page: Page, title: string): Promise<void> {
  await page.getByRole('row', { name: new RegExp(title) }).dblclick();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

test('1. the first launch turns a legacy folder list into projects: backup, notice once, meetings and links intact', async () => {
  const root = newRoot();
  const original = seedLegacyLibrary(root);
  const link = (title: string, id: string): string =>
    `[${title}](https://meetinglive.local/meeting/${id.replace(/-/g, '')})`;
  const env = {
    VOZELLA_FAKE_CHAT_REPLY: `See ${link('Roadmap sync', LEGACY_MEETINGS.roadmap)} and ${link('Limits class', LEGACY_MEETINGS.limits)}.`,
  };
  const first = await open(root, env);
  try {
    const { page } = first;
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(6);
    for (const name of [
      'Universidad',
      'Universidad – Calculo',
      'Trabajo',
      'Trabajo – Calculo',
      'Producto Q4',
      'Huerfana',
    ]) {
      await expect(cardLink(page, name)).toBeVisible();
    }
    // The unfiled meeting and the one whose folder is gone both wait under No project.
    await expect(noProjectRow(page)).toContainText('2 meetings');

    const notice = page.getByTestId('migration-notice');
    await expect(notice).toContainText('6 folders became projects.');
    await expect(notice).toContainText('2 were renamed to avoid duplicates.');

    // The old list is kept byte for byte in the backups folder, and is gone from the library.
    expect(fs.existsSync(path.join(libraryOf(root), 'folders.json'))).toBe(false);
    const [backup, ...extra] = backupsOf(root);
    expect(extra).toEqual([]);
    expect(backupBytes(root, backup ?? '').equals(original)).toBe(true);

    // The note became the instructions, and the meeting is where it was.
    await cardLink(page, 'Producto Q4').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Producto Q4' })).toBeVisible();
    await expect(page.getByText('Use a formal tone.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Roadmap sync/ })).toBeVisible();
    expect(
      fs.existsSync(path.join(libraryOf(root), 'Producto Q4', '2026-09-03 Roadmap sync.md')),
    ).toBe(true);

    // Meetings of the migrated projects open, in the nested ones too.
    await openProjectPage(page, 'Universidad – Calculo');
    await openMeetingFromList(page, 'Limits class');
    await openProjectPage(page, 'Trabajo – Calculo');
    await openMeetingFromList(page, 'Budget review');
    await goToProjects(page);
    await noProjectRow(page).click();
    await openMeetingFromList(page, 'Lost folder');

    // Links in an answer to meetings that were migrated still resolve.
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    await openProjectPage(page, 'Producto Q4');
    await page.getByRole('tab', { name: 'Chats' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    const composer = page.getByTestId('TxtMeetingChat');
    await composer.fill('Where was the roadmap discussed?');
    await composer.press('Enter');
    const answers = page.getByTestId('ListMeetingChat');
    await answers.getByRole('link', { name: 'Limits class' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Limits class' })).toBeVisible();

    await goToProjects(page);
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  } finally {
    await end(first);
  }

  // A second launch on the same root changes nothing and says nothing.
  const second = await open(root);
  try {
    await goToProjects(second.page);
    await expect(second.page.getByRole('article')).toHaveCount(6);
    await expect(second.page.getByTestId('migration-notice')).toHaveCount(0);
    expect(backupsOf(root)).toHaveLength(1);
    expect(fs.existsSync(path.join(libraryOf(root), 'folders.json'))).toBe(false);
  } finally {
    await end(second);
  }
});

test('2. a list kept only in the app data is adopted; a malformed list never stops the app', async () => {
  // The old list lived in the app data folder in some versions.
  const adopted = newRoot();
  const adoptedBytes = writeLegacyFolders(
    adopted,
    [
      { id: guid(21), name: 'Alpha', parentId: null },
      { id: guid(22), name: 'Beta', parentId: guid(21) },
    ],
    'app-data',
  );
  writeMeeting(libraryOf(adopted), {
    id: guid(23),
    title: 'Alpha kickoff',
    recordedAt: at(1),
    directory: 'Alpha',
    projectId: guid(21),
  });
  const one = await open(adopted);
  try {
    await goToProjects(one.page);
    await expect(cardLink(one.page, 'Alpha')).toBeVisible();
    await expect(cardLink(one.page, 'Beta')).toBeVisible();
    await expect(one.page.getByTestId('migration-notice')).toContainText(
      '2 folders became projects.',
    );
    const [backup] = backupsOf(adopted);
    expect(backupBytes(adopted, backup ?? '').equals(adoptedBytes)).toBe(true);
    await openProjectPage(one.page, 'Alpha');
    await openMeetingFromList(one.page, 'Alpha kickoff');
  } finally {
    await end(one);
  }

  // Repeated ids, ids that differ only by case, a loop and an invalid id.
  const broken = newRoot();
  const brokenBytes = writeLegacyFolders(broken, [
    { id: guid(31), name: 'Alpha', parentId: null },
    { id: guid(31), name: 'Alpha again', parentId: null },
    { id: guid(32), name: 'Beta', parentId: null },
    { id: guid(32).toUpperCase(), name: 'Beta shouting', parentId: null },
    { id: guid(33), name: 'Loop A', parentId: guid(34) },
    { id: guid(34), name: 'Loop B', parentId: guid(33) },
    { id: 'not-an-id', name: 'Nameless', parentId: null },
  ]);
  const library = libraryOf(broken);
  writeMeeting(library, {
    id: guid(41),
    title: 'Alpha notes',
    recordedAt: at(1),
    directory: 'Alpha',
    projectId: guid(31),
  });
  writeMeeting(library, {
    id: guid(42),
    title: 'Loop notes',
    recordedAt: at(2),
    directory: 'Loop A',
    projectId: guid(33),
  });
  writeMeeting(library, {
    id: guid(43),
    title: 'Nameless notes',
    recordedAt: at(3),
    projectId: 'not-an-id',
  });
  writeMeeting(library, { id: guid(44), title: 'Plain notes', recordedAt: at(4) });
  const two = await open(broken);
  try {
    const { page } = two;
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(4);
    for (const name of ['Alpha', 'Beta', 'Loop A', 'Loop B']) {
      await expect(cardLink(page, name)).toBeVisible();
    }
    await expect(page.getByTestId('migration-notice')).toContainText(
      '3 folders could not be converted because their ids were invalid or repeated.',
    );
    expect(backupBytes(broken, backupsOf(broken)[0] ?? '').equals(brokenBytes)).toBe(true);

    // Every meeting still opens: in its project, and under No project.
    await cardLink(page, 'Alpha').click();
    await openMeetingFromList(page, 'Alpha notes');
    await openProjectPage(page, 'Loop A');
    await openMeetingFromList(page, 'Loop notes');
    await goToProjects(page);
    await noProjectRow(page).click();
    await openMeetingFromList(page, 'Nameless notes');
    await goToProjects(page);
    await noProjectRow(page).click();
    await openMeetingFromList(page, 'Plain notes');
  } finally {
    await end(two);
  }
});

test('3. a library made by a newer version keeps its manifest, lists its meetings and refuses project changes', async () => {
  const root = newRoot();
  const library = libraryOf(root);
  fs.mkdirSync(path.join(library, '.vozella'), { recursive: true });
  const manifest = path.join(library, '.vozella', 'library.json');
  fs.writeFileSync(manifest, '{"schemaVersion":99}\n');
  const before = fs.readFileSync(manifest);
  writeMeeting(library, { id: guid(51), title: 'Still here', recordedAt: at(1) });
  const session = await open(root);
  try {
    const { page } = session;
    await goToProjects(page);
    await expect(page.getByTestId('projects-storage-newer')).toContainText(
      'This library was created by a newer version of Vozella.',
    );
    await expect(page.getByRole('button', { name: 'New project' })).toBeDisabled();
    await expect(noProjectRow(page)).toContainText('1 meeting');

    // The meeting is listed and opens, and moving it is not offered.
    await goToLibrary(page);
    const row = page.getByRole('row', { name: /Still here/ });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to project' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Projects are unavailable right now.' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await openMeetingFromList(page, 'Still here');
    expect(fs.readFileSync(manifest).equals(before)).toBe(true);
  } finally {
    await end(session);
  }
  expect(fs.readFileSync(manifest).equals(before)).toBe(true);
});

test('4. a project is created, found, sorted, pinned and edited in place', async () => {
  const root = newRoot();
  const session = await open(root);
  try {
    const { page } = session;
    await goToProjects(page);
    await expect(
      page.getByText('A project keeps related meetings, instructions and files together.'),
    ).toBeVisible();

    // Create: an empty name is refused where it is typed; a valid one opens the new project.
    await page.getByRole('button', { name: 'New project' }).click();
    const name = page.getByRole('textbox', { name: 'Name' });
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Enter a name for the project.')).toBeVisible();
    await name.fill('Alpha');
    await page.getByRole('textbox', { name: 'Description (optional)' }).fill('The first one');
    await name.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Alpha', exact: true })).toBeVisible();
    await expect(page.getByText('The first one')).toBeVisible();

    // A name that only differs by case or by accents is taken.
    await goToProjects(page);
    await page.getByRole('button', { name: 'New project' }).click();
    for (const taken of ['alpha', 'ÁLPHA']) {
      await page.getByRole('textbox', { name: 'Name' }).fill(taken);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByText('A project with this name already exists.')).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);

    // Two more, made at different moments; each has one meeting, on different days.
    await createProject(page, 'Gamma');
    await createProject(page, 'Beta');
    const library = libraryOf(root);
    writeMeeting(library, {
      id: guid(61),
      title: 'Alpha day',
      recordedAt: later(1),
      directory: 'Alpha',
      projectId: await projectIdOf(page, 'Alpha'),
    });
    writeMeeting(library, {
      id: guid(62),
      title: 'Gamma day',
      recordedAt: later(5),
      directory: 'Gamma',
      projectId: await projectIdOf(page, 'Gamma'),
    });
    writeMeeting(library, {
      id: guid(63),
      title: 'Beta day',
      recordedAt: later(3),
      directory: 'Beta',
      projectId: await projectIdOf(page, 'Beta'),
    });
    // The library reads its files again when it is opened.
    await page.reload();
    await goToLibrary(page);
    await expect(page.locator('[data-row-id]')).toHaveCount(3);
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(3);

    // Sort: recent activity first, by name, newest created first.
    const sortBy = async (option: string): Promise<void> => {
      await page.getByRole('combobox', { name: 'Sort projects' }).click();
      await page.getByRole('option', { name: option }).click();
    };
    await expect.poll(() => cardNames(page)).toEqual(['Gamma', 'Beta', 'Alpha']);
    await sortBy('Name');
    await expect.poll(() => cardNames(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
    await sortBy('Newest');
    await expect.poll(() => cardNames(page)).toEqual(['Beta', 'Gamma', 'Alpha']);
    await sortBy('Recent activity');

    // Search narrows the cards and says how many are left; nothing found says so, and clears.
    const search = page.getByRole('searchbox', { name: 'Search projects' });
    await search.fill('bet');
    await expect.poll(() => cardNames(page)).toEqual(['Beta']);
    await expect(page.getByRole('status', { name: 'Search results' })).toHaveText(
      '1 project found',
    );
    await search.fill('zzz');
    await expect(page.getByText('No projects match "zzz".')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).first().click();
    await expect(page.getByRole('article')).toHaveCount(3);

    // Pin: the pinned project moves to its own group, and back.
    await page.getByRole('button', { name: 'Pin Gamma' }).click();
    const pinned = page.getByRole('region', { name: 'Pinned' });
    await expect(pinned.getByRole('article')).toHaveCount(1);
    await expect(pinned.getByRole('heading', { level: 3, name: 'Gamma' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'All projects' })).toBeVisible();
    await page.getByRole('button', { name: 'Unpin Gamma' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Pinned' })).toHaveCount(0);

    // Rename and describe in place: no dialog opens for either.
    await cardLink(page, 'Gamma').click();
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Name' });
    await field.fill('beta');
    await field.press('Enter');
    await expect(page.getByRole('alert')).toContainText('A project with this name already exists.');
    await field.fill('Gamma Prime');
    await field.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Gamma Prime' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a description' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const description = page.getByRole('textbox', { name: 'Description' });
    await description.fill('About gamma');
    await description.press('Enter');
    await expect(page.getByText('About gamma')).toBeVisible();
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit description' }).click();
    await page.getByRole('textbox', { name: 'Description' }).fill('Changed');
    await page.getByRole('textbox', { name: 'Description' }).press('Enter');
    await expect(page.getByText('Changed')).toBeVisible();

    await goToProjects(page);
    await expect(cardLink(page, 'Gamma Prime')).toBeVisible();
    await expect(page.getByText('Changed')).toBeVisible();
  } finally {
    await end(session);
  }
});

/** The id of a project, by its name, as the app lists it. */
async function projectIdOf(page: Page, name: string): Promise<string> {
  const listed = await page.evaluate(() => window.vozella.invoke('projects.list', {}));
  const found = listed.projects.find((project) => project.name === name);
  if (!found) throw new Error(`no project called ${name}`);
  return found.id;
}

test('5. instructions and context files are edited in the project page and kept in the project', async () => {
  const root = newRoot();
  const aside = path.join(root, 'picked');
  fs.mkdirSync(aside, { recursive: true });
  const notes = path.join(aside, 'notes.txt');
  fs.writeFileSync(notes, 'The marketing budget is 42000 dollars.');
  const plan = path.join(aside, 'plan.pdf');
  fs.writeFileSync(plan, tinyPdf('Launch moves to October'));
  const spec = path.join(aside, 'spec.docx');
  fs.writeFileSync(spec, minimalDocx(['The glossary starts here.']));
  const picture = path.join(aside, 'photo.png');
  fs.writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
  const before = fs.readFileSync(notes);

  const first = await open(root);
  try {
    const { page, app } = first;
    const projectId = await createProject(page, 'Finance');
    await openProjectPage(page, 'Finance');
    const side = page.getByRole('complementary', { name: 'Project details' });

    // Instructions: a counter while typing, Cancel keeps the old text, Save keeps the new one.
    await expect(
      side.getByText('Tell Vozella how to summarize and answer for this project.'),
    ).toBeVisible();
    await side.getByRole('button', { name: 'Edit instructions' }).click();
    const box = side.getByRole('textbox', { name: 'Instructions' });
    await box.fill('Answer in formal Spanish.');
    await expect(side.getByText('25 of 20,000 characters')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await side.getByRole('button', { name: 'Save' }).click();
    await expect(side.getByText('Answer in formal Spanish.')).toBeVisible();
    await side.getByRole('button', { name: 'Edit instructions' }).click();
    await side.getByRole('textbox', { name: 'Instructions' }).fill('Something else entirely.');
    await side.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(side.getByText('Answer in formal Spanish.')).toBeVisible();
    await expect(side.getByText('Something else entirely.')).toHaveCount(0);

    // Files: a text, a PDF and a Word file come in through the picker, with what each is.
    await pickNext(app, [notes, plan, spec]);
    await side.getByRole('button', { name: 'Add' }).click();
    const files = side.getByRole('listitem');
    await expect(files).toHaveCount(3);
    await expect(files.filter({ hasText: 'notes.txt' })).toContainText('Text · 38 B');
    await expect(files.filter({ hasText: 'plan.pdf' })).toContainText('PDF · 1 page');
    await expect(files.filter({ hasText: 'spec.docx' })).toContainText('Word');
    // The project keeps its own copies; the originals stay where they were.
    const stored = path.join(projectDir(root, projectId), 'files');
    expect(fs.readdirSync(stored)).toHaveLength(3);
    expect(fs.readFileSync(notes).equals(before)).toBe(true);
    expect(fs.existsSync(plan)).toBe(true);
    expect(fs.existsSync(spec)).toBe(true);

    // The same file twice and a picture are refused, each with its reason, and take no room.
    await pickNext(app, [notes]);
    await side.getByRole('button', { name: 'Add' }).click();
    await expect(side.getByRole('alert')).toContainText('notes.txt: Duplicate');
    await side.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
    await pickNext(app, [picture]);
    await side.getByRole('button', { name: 'Add' }).click();
    await expect(side.getByRole('alert')).toContainText('photo.png: Not supported');
    await side.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
    expect(fs.readdirSync(stored)).toHaveLength(3);

    await side.getByRole('button', { name: 'Remove notes.txt' }).click();
    await expect(files).toHaveCount(2);
    await expect.poll(() => fs.readdirSync(stored).length).toBe(2);
    expect(fs.existsSync(notes)).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await end(first);
  }

  // Everything is still there after a relaunch.
  const second = await open(root);
  try {
    await openProjectPage(second.page, 'Finance');
    const side = second.page.getByRole('complementary', { name: 'Project details' });
    await expect(side.getByText('Answer in formal Spanish.')).toBeVisible();
    await expect(side.getByRole('listitem')).toHaveCount(2);
    await expect(side.getByText('plan.pdf')).toBeVisible();
  } finally {
    await end(second);
  }
});

/** A take is started from the project page and runs to a saved meeting: the shared steps of the specs below. */
async function readyForTakes(session: Session): Promise<void> {
  await nav(session.page, 'Record').click();
  await installEngine(session.page);
  await expect(session.page.getByTestId('BtnRecord')).toBeEnabled({ timeout: 30_000 });
}

const takeState = (page: Page) =>
  page.evaluate(() => window.vozella.invoke('recording.getState', {}));

async function stopAndWaitForResult(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Stop' }).click();
  const card = page.getByTestId('result-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('status-text')).not.toContainText('Generating', {
    timeout: 60_000,
  });
}

/** The Markdown files of a directory of the library, found by their title text. */
function meetingFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.md')) : [];
}

test('6. Start meeting in this project records into it once, and a second start never takes over', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const promptLog = path.join(root, 'prompts.log');
  const session = await open(root, {
    ...readyEnv,
    VOZELLA_FAKE_AUDIO_APPS: FAKE_APPS,
    VOZELLA_FAKE_CHAT_PROMPT_LOG: promptLog,
  });
  try {
    const { page } = session;
    const calls = await createProject(page, 'Calls', 'Keep every answer under two sentences.');
    const other = await createProject(page, 'Other', 'Other instructions.');
    await readyForTakes(session);

    // From the project page: Record opens on the project, the take starts, the address is clean.
    await openProjectPage(page, 'Calls');
    await page.getByRole('button', { name: 'Start meeting in this project' }).first().click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/#\/record$/);
    expect((await takeState(page)).projectId).toBe(calls);

    // A reload does not start another take, and does not complain about one.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/#\/record$/);
    await expect(page.getByText('A meeting is already recording')).toHaveCount(0);

    // The live copilot of the take is given the instructions of its project, and only those.
    const composer = page.getByTestId('TxtMeetingChat');
    const launcher = page.getByTestId('BtnAiPanelOpen');
    await expect(launcher.or(composer).filter({ visible: true })).toBeVisible();
    if (await launcher.isVisible()) await launcher.click();
    await composer.fill('What was just said?');
    await composer.press('Enter');
    await expect(
      page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
    ).toBeVisible({ timeout: 30_000 });
    const asked = fs.readFileSync(promptLog, 'utf8');
    expect(asked).toContain('Keep every answer under two sentences.');
    expect(asked).not.toContain('Other instructions.');

    // Start in another project while this one records: it says so, and nothing changes.
    await openProjectPage(page, 'Other');
    await page.getByRole('button', { name: 'Start meeting in this project' }).first().click();
    await expect(page.getByText('A meeting is already recording')).toBeVisible();
    await expect(page.getByTestId('take-destination')).toHaveText('Saving to Calls');
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText('Saving to Calls'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect((await takeState(page)).projectId).toBe(calls);
    expect((await takeState(page)).projectId).not.toBe(other);

    // Stop: the meeting is the first of its project, saved in its directory, and not unfiled.
    await stopAndWaitForResult(page);
    await openProjectPage(page, 'Calls');
    await expect(page.locator('[data-row-id]')).toHaveCount(1);
    expect(meetingFiles(path.join(libraryOf(root), 'Calls'))).toHaveLength(1);
    await goToProjects(page);
    await expect(noProjectRow(page)).toHaveCount(0);
    await expect(cardLink(page, 'Calls').locator('xpath=ancestor::article')).toContainText(
      '1 meeting',
    );
  } finally {
    await end(session);
  }
});

test('6b. an address that starts a take in a project that is gone selects No project and starts nothing', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const session = await open(root, readyEnv);
  try {
    const { page } = session;
    const gone = await createProject(page, 'Short lived');
    await page.evaluate((id) => window.vozella.invoke('projects.delete', { id }), gone);
    await readyForTakes(session);
    await page.evaluate((id) => {
      window.location.hash = `#/record?project=${id}&start=1`;
    }, gone);
    await expect(
      page.getByText('That project no longer exists. Choose where to save this meeting.'),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Save to' })).toContainText('No project');
    await expect(page).toHaveURL(/#\/record$/);
    // Nothing started, and nothing will on its own.
    await page.waitForTimeout(1_500);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    expect((await takeState(page)).phase).toBe('Idle');
  } finally {
    await end(session);
  }
});

test('7. the model is given what the project holds, and a meeting of another project is not', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const aside = path.join(root, 'picked');
  fs.mkdirSync(aside, { recursive: true });
  // Far more text than fits, so the excerpts are chosen by the question: the sentence that
  // answers it is at the very end of the file, where a plain head cut would never reach.
  const filler = 'The office plants need water on Mondays. '.repeat(900);
  const budget = path.join(aside, 'budget.txt');
  fs.writeFileSync(budget, `${filler}\nThe marketing budget is 42000 dollars.`);
  const bakery = path.join(aside, 'bakery.txt');
  fs.writeFileSync(bakery, 'The sourdough starter needs feeding daily. '.repeat(800));
  const chatLog = path.join(aside, 'chat.log');
  const summaryLog = path.join(aside, 'summary.log');
  const session = await open(root, {
    ...readyEnv,
    VOZELLA_FAKE_AUDIO_APPS: FAKE_APPS,
    VOZELLA_FAKE_CHAT_PROMPT_LOG: chatLog,
    VOZELLA_FAKE_SUMMARY_PROMPT_LOG: summaryLog,
  });
  try {
    const { page, app } = session;
    await createProject(page, 'Finance', 'Always answer in formal Spanish.');
    await createProject(page, 'Other', 'Other instructions.');
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    await openProjectPage(page, 'Finance');
    await pickNext(app, [budget, bakery]);
    await page
      .getByRole('complementary', { name: 'Project details' })
      .getByRole('button', { name: 'Add' })
      .click();
    await expect(
      page.getByRole('complementary', { name: 'Project details' }).getByRole('listitem'),
    ).toHaveCount(2);

    // A chat of the project: the instructions and the excerpt that answers the question.
    const ask = async (question: string): Promise<string> => {
      const had = fs.existsSync(chatLog) ? fs.readFileSync(chatLog, 'utf8').length : 0;
      await page.getByRole('tab', { name: 'Chats' }).click();
      await page.getByRole('tabpanel').getByRole('button', { name: 'New chat' }).click();
      const composer = page.getByTestId('TxtMeetingChat');
      await composer.fill(question);
      await composer.press('Enter');
      await expect(
        page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
      ).toBeVisible({ timeout: 30_000 });
      return fs.readFileSync(chatLog, 'utf8').slice(had);
    };
    const finance = await ask('What is the marketing budget?');
    expect(finance).toContain('Always answer in formal Spanish.');
    expect(finance).toContain('The marketing budget is 42000 dollars.');
    expect(finance).not.toContain(aside);

    // The chat of another project is given its own instructions and nothing of this one.
    await openProjectPage(page, 'Other');
    const other = await ask('What is the marketing budget?');
    expect(other).toContain('Other instructions.');
    expect(other).not.toContain('Always answer in formal Spanish.');
    expect(other).not.toContain('42000 dollars');

    // A take in each project: the summary prompt carries the project's blocks, and only its own.
    await readyForTakes(session);
    for (const name of ['Finance', 'Other']) {
      await openProjectPage(page, name);
      await page.getByRole('button', { name: 'Start meeting in this project' }).first().click();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_000);
      await stopAndWaitForResult(page);
    }
    await expect
      .poll(
        () =>
          (fs.existsSync(summaryLog) ? fs.readFileSync(summaryLog, 'utf8') : '').split('# Identity')
            .length,
        { timeout: 60_000 },
      )
      .toBe(3);
    const [, forFinance = '', forOther = ''] = fs
      .readFileSync(summaryLog, 'utf8')
      .split('# Identity');
    expect(forFinance).toContain(
      '<project_instructions>\nAlways answer in formal Spanish.\n</project_instructions>',
    );
    expect(forFinance).toContain('<project_files>');
    expect(forFinance).toContain('The marketing budget is 42000 dollars.');
    expect(forOther).toContain(
      '<project_instructions>\nOther instructions.\n</project_instructions>',
    );
    expect(forOther).not.toContain('<project_files>');
    expect(forOther).not.toContain('Always answer in formal Spanish.');
    expect(forOther).not.toContain('42000 dollars');
  } finally {
    await end(session);
  }
});

const chatRows = (page: Page) => page.getByRole('tabpanel').getByRole('listitem');

/** Sends a question in a new chat of the tab on screen, and waits for the answer. */
async function startChat(page: Page, question: string): Promise<void> {
  await page.getByRole('tab', { name: 'Chats' }).click();
  await page.getByRole('tabpanel').getByRole('button', { name: 'New chat' }).click();
  const composer = page.getByTestId('TxtMeetingChat');
  await composer.fill(question);
  await composer.press('Enter');
  await expect(
    page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
  ).toBeVisible({ timeout: 30_000 });
}

/** The saved chats of a project; an atomic write is a temporary file for a moment, which is not a chat. */
const chatsOf = (root: string, projectId: string): string[] =>
  fs
    .readdirSync(path.join(projectDir(root, projectId), 'chats'))
    .filter((name) => /^[0-9a-f-]+\.json$/.test(name));

/** The saved chat files under every owner of a library, by file name. */
function chatFiles(root: string): string[] {
  return treeOf(path.join(libraryOf(root), '.vozella')).filter((file) =>
    /chats[\\/][^\\/]+\.json$/.test(file),
  );
}

test('8. chats belong to a project: listed there, back after a relaunch, renamed, deleted, and read only once their meeting is gone', async () => {
  const root = newRoot();
  const first = await open(root);
  let projectId = '';
  try {
    const { page } = first;
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    projectId = await createProject(page, 'Research');
    await openProjectPage(page, 'Research');
    await startChat(page, 'First question');
    await page.getByTestId('BtnMeetingChatNew').click();
    await page.getByTestId('TxtMeetingChat').fill('Second question');
    await page.getByTestId('TxtMeetingChat').press('Enter');
    await expect(page.getByTestId('ListMeetingChat').getByText('Second question')).toBeVisible();
    await expect(
      page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
    ).toBeVisible();

    // A chat that belongs to no project, from its own page.
    await goToProjects(page);
    // The No project row needs a meeting to exist; the page is reachable by address as well.
    await page.evaluate(() => {
      window.location.hash = '#/projects/none';
    });
    await expect(page.getByRole('heading', { level: 1, name: 'No project' })).toBeVisible();
    await startChat(page, 'Unfiled question');
    await expect(chatRows(page)).toHaveCount(1);
    await expect(chatRows(page).first()).toContainText('Unfiled question');

    // The project lists its own chats only, newest first.
    await openProjectPage(page, 'Research');
    await page.getByRole('tab', { name: 'Chats' }).click();
    await expect(chatRows(page)).toHaveCount(2);
    await expect
      .poll(() => chatRows(page).evaluateAll((rows) => rows.map((row) => row.textContent)))
      .toEqual([
        expect.stringContaining('Second question'),
        expect.stringContaining('First question'),
      ]);
    expect(chatFiles(root)).toHaveLength(3);
    expect(chatsOf(root, projectId)).toHaveLength(2);
  } finally {
    await end(first);
  }

  // After a relaunch the chat is listed, opens with its messages, and the conversation goes on.
  const second = await open(root);
  try {
    const { page } = second;
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    await openProjectPage(page, 'Research');
    await page.getByRole('tab', { name: 'Chats' }).click();
    await page
      .getByRole('tabpanel')
      .getByRole('button', { name: /^First question/ })
      .click();
    const list = page.getByTestId('ListMeetingChat');
    await expect(list.getByText('First question')).toBeVisible();
    await expect(list.getByText('The team went over the plan')).toBeVisible();
    await page.getByTestId('TxtMeetingChat').fill('A follow-up');
    await page.getByTestId('TxtMeetingChat').press('Enter');
    await expect(list.getByText('A follow-up')).toBeVisible();
    await expect(list.getByText('The team went over the plan')).toHaveCount(2);
    // It went on in the same chat: no third chat appeared.
    expect(chatsOf(root, projectId)).toHaveLength(2);

    // Rename in place.
    await page.getByRole('button', { name: 'Actions for First question' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const title = page.getByRole('textbox', { name: 'Rename' });
    await title.fill('Budget thread');
    await title.press('Enter');
    await expect(chatRows(page).filter({ hasText: 'Budget thread' })).toHaveCount(1);

    // The panel's History lists the same chats as the tab.
    await page.getByTestId('BtnMeetingChatHistory').click();
    const history = page.getByRole('dialog', { name: 'Chat history' });
    await expect(history.getByRole('listitem')).toHaveCount(2);
    await expect(history).toContainText('Budget thread');
    await expect(history).toContainText('Second question');
    await expect(history).not.toContainText('Unfiled question');
    await page.keyboard.press('Escape');

    // Delete asks first, then the row and the file are gone.
    await page.getByRole('button', { name: 'Actions for Second question' }).click();
    await page
      .getByRole('menu', { name: 'Actions for Second question' })
      .getByRole('menuitem', { name: 'Delete' })
      .click();
    const confirm = page.getByRole('dialog', { name: 'Delete this chat?' });
    await expect(confirm).toContainText('"Second question" and its messages are deleted.');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(chatRows(page)).toHaveCount(1);
    await expect.poll(() => chatsOf(root, projectId).length).toBe(1);
  } finally {
    await end(second);
  }

  // A chat about one meeting outlives the meeting, and then it can only be read.
  const third = await open(root);
  try {
    const { page } = third;
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    writeMeeting(libraryOf(root), {
      id: guid(71),
      title: 'Doomed meeting',
      recordedAt: at(2),
      directory: 'Research',
      projectId,
      summary: 'Agreed to ship.',
    });
    await goToLibrary(page);
    await openMeetingFromList(page, 'Doomed meeting');
    await page
      .getByTestId('BtnAiPanelOpen')
      .click()
      .catch(() => undefined);
    const composer = page.getByTestId('TxtMeetingChat');
    await composer.fill('Summarize this meeting');
    await composer.press('Enter');
    await expect(
      page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
    ).toBeVisible({ timeout: 30_000 });

    await goToLibrary(page);
    const row = page.getByRole('row', { name: /Doomed meeting/ });
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('row', { name: /Doomed meeting/ })).toHaveCount(0);

    await openProjectPage(page, 'Research');
    await page.getByRole('tab', { name: 'Chats' }).click();
    const orphan = chatRows(page).filter({ hasText: 'Summarize this meeting' });
    await expect(orphan).toContainText('Meeting deleted');
    await orphan.getByRole('button', { name: /^Summarize this meeting/ }).click();
    await expect(page.getByText('The meeting for this chat was deleted.')).toBeVisible();
    await expect(page.getByTestId('TxtMeetingChat')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Start a new chat' })).toBeVisible();
  } finally {
    await end(third);
  }
});

const inLibrary = (root: string, directory: string, title: string, day: number): string =>
  path.join(libraryOf(root), directory, `2026-09-0${String(day)} ${title}`);

test('9. unfiled meetings move to a project one by one and in bulk, with undo, and the library filters by project', async () => {
  const root = newRoot();
  const library = libraryOf(root);
  const titles = ['Inbox one', 'Inbox two', 'Inbox three', 'Inbox four', 'Inbox five'];
  titles.forEach((title, index) => {
    writeMeeting(library, {
      id: guid(81 + index),
      title,
      recordedAt: at(index + 1),
      withAudio: index === 0,
    });
  });
  const session = await open(root);
  try {
    const { page } = session;
    await createProject(page, 'Archive');
    await createProject(page, 'Active');
    await createProject(page, 'Empty');
    await goToLibrary(page);
    await goToProjects(page);
    await expect(noProjectRow(page)).toContainText('5 meetings');

    // No project lists what is unfiled.
    await noProjectRow(page).click();
    await expect(page.getByRole('heading', { level: 1, name: 'No project' })).toBeVisible();
    const rows = page.locator('[data-row-id]');
    await expect(rows).toHaveCount(5);
    const row = (title: string) => page.getByRole('row', { name: new RegExp(title) });

    // Move one from its row menu: the recording goes with it, and Undo brings both back.
    await row('Inbox one').getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to project' }).click();
    await page.getByRole('combobox', { name: 'Search projects' }).fill('arch');
    await page.getByRole('option', { name: 'Archive' }).click();
    await expect(rows).toHaveCount(4);
    await expect(page.getByText('Moved "Inbox one" to Archive.')).toBeVisible();
    expect(fs.existsSync(inLibrary(root, 'Archive', 'Inbox one.md', 1))).toBe(true);
    expect(fs.existsSync(inLibrary(root, 'Archive', 'Inbox one.wav', 1))).toBe(true);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Inbox one.md', 1))).toBe(false);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(rows).toHaveCount(5);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Inbox one.md', 1))).toBe(true);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Inbox one.wav', 1))).toBe(true);
    expect(fs.existsSync(inLibrary(root, 'Archive', 'Inbox one.md', 1))).toBe(false);

    // And once more, for good; the card counts follow.
    await row('Inbox one').getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to project' }).click();
    await page.getByRole('option', { name: 'Archive' }).click();
    await expect(rows).toHaveCount(4);

    // Three checked meetings move together from the bar, and Undo returns the three.
    const bar = page.getByRole('toolbar', { name: 'Checked meetings' });
    for (const title of ['Inbox two', 'Inbox three', 'Inbox four']) {
      await row(title).getByRole('checkbox').click();
    }
    await expect(bar.getByText('Checked: 3')).toBeVisible();
    await bar.getByRole('button', { name: 'Move to project' }).click();
    await page.getByRole('option', { name: 'Active' }).click();
    await expect(rows).toHaveCount(1);
    await expect(page.getByText('Moved 3 meetings to Active.')).toBeVisible();
    for (const [index, title] of ['Inbox two', 'Inbox three', 'Inbox four'].entries()) {
      expect(fs.existsSync(inLibrary(root, 'Active', `${title}.md`, index + 2))).toBe(true);
    }
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(rows).toHaveCount(4);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Inbox three.md', 3))).toBe(true);
    for (const title of ['Inbox two', 'Inbox three', 'Inbox four']) {
      await row(title).getByRole('checkbox').click();
    }
    await bar.getByRole('button', { name: 'Move to project' }).click();
    await page.getByRole('option', { name: 'Active' }).click();
    await expect(rows).toHaveCount(1);

    await goToProjects(page);
    await expect(cardLink(page, 'Archive').locator('xpath=ancestor::article')).toContainText(
      '1 meeting',
    );
    await expect(cardLink(page, 'Active').locator('xpath=ancestor::article')).toContainText(
      '3 meetings',
    );
    await expect(cardLink(page, 'Empty').locator('xpath=ancestor::article')).toContainText(
      '0 meetings',
    );
    await expect(noProjectRow(page)).toContainText('1 meeting');

    // The Library filters by project, and says so when a project has nothing.
    await goToLibrary(page);
    await expect(rows).toHaveCount(5);
    const filter = page.getByTestId('library-project-filter');
    const choose = async (name: string): Promise<void> => {
      await filter.click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    await choose('Active');
    await expect(rows).toHaveCount(3);
    await choose('No project');
    await expect(rows).toHaveCount(1);
    await expect(row('Inbox five')).toBeVisible();
    await choose('Empty');
    await expect(page.getByText('No meetings in Empty.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(rows).toHaveCount(5);
    await expect(filter).toContainText('All projects');
  } finally {
    await end(session);
  }
});

test('10. deleting a project moves its meetings to No project and removes what it held, and a child project keeps its own', async () => {
  const root = newRoot();
  seedLegacyLibrary(root);
  // A meeting that sits in the parent directory itself, which also contains the child's directory.
  writeMeeting(libraryOf(root), {
    id: guid(91),
    title: 'Intro class',
    recordedAt: at(7),
    directory: 'Universidad',
    projectId: LEGACY.universidad,
    withAudio: true,
  });
  const aside = path.join(root, 'picked');
  fs.mkdirSync(aside, { recursive: true });
  const notes = path.join(aside, 'syllabus.txt');
  fs.writeFileSync(notes, 'The syllabus covers limits.');
  const session = await open(root);
  try {
    const { page, app } = session;
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    await page.evaluate(
      ([id]) =>
        window.vozella.invoke('projects.setInstructions', {
          id: id ?? '',
          instructions: 'Be brief.',
        }),
      [LEGACY.universidad],
    );
    await openProjectPage(page, 'Universidad');
    await pickNext(app, [notes]);
    const side = page.getByRole('complementary', { name: 'Project details' });
    await side.getByRole('button', { name: 'Add' }).click();
    await expect(side.getByText('syllabus.txt')).toBeVisible();
    await startChat(page, 'About the syllabus');
    const held = projectDir(root, LEGACY.universidad);
    expect(treeOf(held).length).toBeGreaterThan(2);

    // The confirmation names what happens to the meetings.
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete project?' });
    await expect(confirm).toContainText('Its 1 meeting moves to No project.');
    await confirm.getByRole('button', { name: 'Delete project' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(cardLink(page, 'Universidad')).toHaveCount(0);
    await expect(noProjectRow(page)).toContainText('3 meetings');
    // What the project held is gone: its instructions, its file copy and its chats.
    expect(fs.existsSync(held)).toBe(false);
    expect(chatFiles(root)).toHaveLength(0);
    // The meeting went to the Inbox with its recording; nothing else of the library moved.
    expect(fs.existsSync(inLibrary(root, 'Universidad', 'Intro class.md', 7))).toBe(false);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Intro class.md', 7))).toBe(true);
    expect(fs.existsSync(inLibrary(root, 'Inbox', 'Intro class.wav', 7))).toBe(true);
    expect(fs.existsSync(notes)).toBe(true);

    // The child project lives in a directory inside the deleted one: its meetings stay put.
    expect(
      fs.existsSync(inLibrary(root, path.join('Universidad', 'Calculo'), 'Limits class.md', 1)),
    ).toBe(true);
    await expect(
      cardLink(page, 'Universidad – Calculo').locator('xpath=ancestor::article'),
    ).toContainText('1 meeting');
    await cardLink(page, 'Universidad – Calculo').click();
    await openMeetingFromList(page, 'Limits class');
  } finally {
    await end(session);
  }
});

/** Presses Tab until the focus is on the control called `name`; it must be reached, never skipped. */
async function tabTo(page: Page, name: string, max = 100): Promise<void> {
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      return (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim();
    });
    if (label === name) return;
  }
  throw new Error(`The keyboard never reached "${name}"`);
}

/** Puts the focus back at the top of the page, before its first control. */
const focusPageStart = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });

test('11. the project page is side by side from 960 px and stacked below, both reachable by keyboard', async () => {
  const root = newRoot();
  const session = await open(root);
  try {
    const { page, app } = session;
    await createProject(page, 'Layout', '', 'Checks the page at two widths');
    await resize(app, 1180, 820);
    await openProjectPage(page, 'Layout');
    const layout = page.locator('[data-layout]');
    await expect(layout).toHaveAttribute('data-layout', 'side');
    const side = page.getByRole('complementary', { name: 'Project details' });
    await expect(side.getByRole('heading', { level: 2, name: 'Instructions' })).toBeVisible();
    await expect(side.getByRole('heading', { level: 2, name: 'Context files' })).toBeVisible();

    await focusPageStart(page);
    await tabTo(page, 'Edit instructions');
    await expect(page.getByRole('button', { name: 'Edit instructions' })).toBeFocused();
    await tabTo(page, 'Add');
    await expect(side.getByRole('button', { name: 'Add' })).toBeFocused();

    // Below 960 px the same content is folded sections under the header.
    await resize(app, 900, 820);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(960);
    await expect(layout).toHaveAttribute('data-layout', 'stacked');
    await expect(page.getByRole('complementary', { name: 'Project details' })).toHaveCount(0);
    const instructions = page
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Instructions' }) });
    const files = page
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: 'Context files' }) });
    // Instructions are open while empty; the files are folded until asked for.
    await expect(instructions).toHaveAttribute('open', '');
    await expect(files).not.toHaveAttribute('open', '');

    await focusPageStart(page);
    await tabTo(page, 'Edit instructions');
    await expect(page.getByRole('button', { name: 'Edit instructions' })).toBeFocused();
    await tabTo(page, 'Context files');
    await page.keyboard.press('Enter');
    await expect(files).toHaveAttribute('open', '');
    await tabTo(page, 'Add');
    await expect(files.getByRole('button', { name: 'Add' })).toBeFocused();

    // Back to the wide layout: the page keeps what was typed while it was laid out again.
    await page.getByRole('button', { name: 'Edit instructions' }).click();
    await page.getByRole('textbox', { name: 'Instructions' }).fill('Typed while narrow');
    await resize(app, 1180, 820);
    await expect(layout).toHaveAttribute('data-layout', 'side');
    await expect(side.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Typed while narrow',
    );
  } finally {
    await end(session);
  }
});

/** The project the workspace says is open in the window, or null. */
const selectedProject = async (page: Page): Promise<string | null> =>
  (await page.evaluate(() => window.vozella.invoke('workspace.getState', {}))).selectedProjectId;

/**
 * The only other window of the app that can talk to the main process is the live copilot pill,
 * which exists while a take is running: it is a separate renderer with its own bridge.
 */
async function pillPage(session: Session): Promise<Page> {
  await expect
    .poll(() => session.app.windows().some((p) => p.url().endsWith('/pill.html')), {
      timeout: 30_000,
    })
    .toBe(true);
  const pill = session.app.windows().find((p) => p.url().endsWith('/pill.html'));
  if (!pill) throw new Error('no pill window');
  return pill;
}

test('12. an unknown project is a page that says so, and a project deleted in another window is gone from this one at once', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const session = await open(root, readyEnv);
  try {
    const { page } = session;
    // A deep link to a project that does not exist.
    await page.evaluate(() => {
      window.location.hash = '#/projects/1b7e0000-0000-4000-8000-0000000000aa';
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Project not found' })).toBeVisible();
    await expect(page.getByText('It may have been deleted.')).toBeVisible();
    expect(await selectedProject(page)).toBeNull();
    await page.getByRole('link', { name: 'Back to projects' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    // The library is filtered by a project that is about to go.
    const doomed = await createProject(page, 'Doomed');
    await createProject(page, 'Kept');
    writeMeeting(libraryOf(root), { id: guid(95), title: 'Unrelated', recordedAt: at(1) });
    await goToLibrary(page);
    await page.getByTestId('library-project-filter').click();
    await page.getByRole('option', { name: 'Doomed', exact: true }).click();
    await expect(page.getByText('No meetings in Doomed.')).toBeVisible();

    // A take makes the second window: the pill. This window shows the project that is deleted there.
    await readyForTakes(session);
    await openProjectPage(page, 'Kept');
    await page.getByRole('button', { name: 'Start meeting in this project' }).first().click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    const pill = await pillPage(session);
    await openProjectPage(page, 'Doomed');
    await expect.poll(() => selectedProject(page)).toBe(doomed);
    await page.evaluate(() => {
      (window as unknown as { __stayed: boolean }).__stayed = true;
    });
    const result = await pill.evaluate(
      (id) => window.vozella.invoke('projects.delete', { id }),
      doomed,
    );
    expect(result.ok).toBe(true);

    // This window moves to the not found page without a reload.
    await expect(page.getByRole('heading', { level: 1, name: 'Project not found' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
      true,
    );
    await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();

    // The project it had selected is cleared in the workspace and in the library filter.
    await expect.poll(() => selectedProject(page)).toBeNull();
    await goToLibrary(page);
    await expect(page.getByTestId('library-project-filter')).toContainText('All projects');
    await expect(page.getByRole('row', { name: /Unrelated/ })).toBeVisible();
  } finally {
    await end(session);
  }
});

test('13. choosing another library location migrates it and shows its projects, and leaves the old one untouched', async () => {
  const root = newRoot();
  const original = seedLegacyLibrary(root);
  // A second library, made by an older version too, somewhere else.
  const elsewhere = path.join(root, 'elsewhere');
  const elsewhereBytes = writeLegacyFolders(elsewhere, [
    { id: guid(101), name: 'Atlas', parentId: null, note: 'Remote notes.' },
    { id: guid(102), name: 'Atlas', parentId: guid(101) },
  ]);
  writeMeeting(libraryOf(elsewhere), {
    id: guid(103),
    title: 'Atlas kickoff',
    recordedAt: at(3),
    directory: 'Atlas',
    projectId: guid(101),
  });
  writeMeeting(libraryOf(elsewhere), { id: guid(104), title: 'Loose end', recordedAt: at(4) });
  const session = await open(root);
  try {
    const { page, app } = session;
    await app.evaluate(({ shell }) => {
      shell.openPath = () => Promise.resolve('');
    });
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(6);
    const snapshot = (dir: string): string[] =>
      treeOf(dir).map((file) => `${file}:${fs.readFileSync(path.join(dir, file)).length}`);
    const oldTree = snapshot(libraryOf(root));
    const oldBackups = backupsOf(root);

    await pickNext(app, [libraryOf(elsewhere)]);
    await nav(page, 'Settings').click();
    await page.getByTestId('SettingsTab-general').click();
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await expect(page.getByText(libraryOf(elsewhere), { exact: true })).toBeVisible();

    // The new location is migrated and its projects are the ones shown.
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(2);
    await expect(cardLink(page, 'Atlas')).toBeVisible();
    await expect(cardLink(page, 'Atlas – Atlas')).toBeVisible();
    await expect(cardLink(page, 'Universidad')).toHaveCount(0);
    await expect(page.getByTestId('migration-notice')).toContainText('2 folders became projects.');
    await expect(noProjectRow(page)).toContainText('1 meeting');
    await cardLink(page, 'Atlas').click();
    await expect(page.getByText('Remote notes.')).toBeVisible();
    await openMeetingFromList(page, 'Atlas kickoff');
    expect(fs.existsSync(path.join(libraryOf(elsewhere), 'folders.json'))).toBe(false);
    expect(backupBytes(elsewhere, backupsOf(elsewhere)[0] ?? '').equals(elsewhereBytes)).toBe(true);

    // The old library was not read for this and not written: same files, same sizes.
    expect(snapshot(libraryOf(root))).toEqual(oldTree);
    expect(backupsOf(root)).toEqual(oldBackups);
    expect(original.length).toBeGreaterThan(0);

    // Back to the default location: the first library's projects are as they were.
    await nav(page, 'Settings').click();
    await page.getByTestId('SettingsTab-general').click();
    await page.getByRole('button', { name: 'Use the default folder' }).click();
    await goToProjects(page);
    await expect(page.getByRole('article')).toHaveCount(6);
    expect(backupsOf(root)).toEqual(oldBackups);
  } finally {
    await end(session);
  }
});

async function seriousViolations(page: Page): Promise<unknown[]> {
  // Contrast is only meaningful at rest: let enter and exit animations settle first.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  await page.evaluate(axe.source);
  const results = await page.evaluate(() =>
    (window as unknown as { axe: typeof axe }).axe.run(document),
  );
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
    }));
}

test('14a. Projects, a project page and No project have no serious accessibility violations, in light and dark', async () => {
  const root = newRoot();
  seedLegacyLibrary(root);
  const session = await open(root);
  try {
    const { page } = session;
    await createProject(page, 'Pinned one', 'Be brief.');
    await page.evaluate(async () => {
      const listed = await window.vozella.invoke('projects.list', {});
      const found = listed.projects.find((project) => project.name === 'Pinned one');
      if (found) await window.vozella.invoke('projects.update', { id: found.id, pinned: true });
    });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        window.localStorage.setItem('vozella.theme', value);
      }, theme);
      await page.reload();
      await goToProjects(page);
      await expect(page.getByRole('article')).toHaveCount(7);
      await expect(page.getByTestId('migration-notice')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await seriousViolations(page)).toEqual([]);

      await openProjectPage(page, 'Producto Q4');
      await expect(page.getByText('Use a formal tone.')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByRole('tab', { name: 'Chats' }).click();
      expect(await seriousViolations(page)).toEqual([]);

      await goToProjects(page);
      await noProjectRow(page).click();
      await expect(page.getByRole('heading', { level: 1, name: 'No project' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);

      await goToProjects(page);
      await page.getByRole('button', { name: 'New project' }).click();
      await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');
    }
  } finally {
    await end(session);
  }
});

test('14b. a project is created, opened, given instructions and started with the keyboard alone', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const session = await open(root, readyEnv);
  try {
    const { page } = session;
    await readyForTakes(session);
    await goToProjects(page);
    await focusPageStart(page);

    await tabTo(page, 'New project');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await page.keyboard.type('Keyboard only');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Keyboard only' })).toBeVisible();

    await focusPageStart(page);
    await tabTo(page, 'Edit instructions');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Instructions' })).toBeFocused();
    await page.keyboard.type('Reply in one line.');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('Reply in one line.')).toBeVisible();
    // The focus came back to the control that opened the editor.
    await expect(page.getByRole('button', { name: 'Edit instructions' })).toBeFocused();

    await tabTo(page, 'Start meeting in this project');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    expect((await takeState(page)).projectId).not.toBeNull();
  } finally {
    await end(session);
  }
});

test('14c. Spanish has no raw keys and never says folder or Inbox', async () => {
  const root = newRoot();
  const library = libraryOf(root);
  writeMeeting(library, { id: guid(111), title: 'Reunión de equipo', recordedAt: at(1) });
  const session = await open(root);
  try {
    const { page } = session;
    await page.evaluate(() => window.vozella.invoke('settings.setUiLanguage', { tag: 'es' }));
    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible();
    await createProject(page, 'Planeación', 'Responde en una línea.');
    const seen: string[] = [];
    const read = async (): Promise<void> => {
      seen.push(await page.locator('body').innerText());
    };
    await page.getByRole('navigation').getByRole('link', { name: 'Proyectos' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Proyectos' })).toBeVisible();
    await read();
    await page.getByRole('button', { name: 'Nuevo proyecto' }).click();
    await page.getByRole('button', { name: 'Crear' }).click();
    await read();
    await page.keyboard.press('Escape');
    await page.getByRole('article').getByRole('link', { name: 'Planeación' }).click();
    await read();
    await page.getByRole('tab', { name: 'Chats' }).click();
    await read();
    await page.getByRole('button', { name: 'Acciones del proyecto' }).click();
    await page.getByRole('menuitem', { name: 'Eliminar' }).click();
    await read();
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('link', { name: 'Proyectos' }).click();
    await page.getByRole('link', { name: /^Sin proyecto/ }).click();
    await read();
    await page.getByRole('navigation').getByRole('link', { name: 'Biblioteca' }).click();
    await expect(page.getByRole('grid')).toBeVisible();
    await read();
    await page
      .getByRole('row', { name: /Reunión de equipo/ })
      .getByRole('button')
      .last()
      .click();
    await page.getByRole('menuitem', { name: 'Mover a proyecto' }).click();
    await read();
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('link', { name: 'Grabar' }).click();
    await read();

    for (const text of seen) {
      expect(text).not.toMatch(/\bUi_[A-Za-z]+/);
      expect(text).not.toMatch(/\{\d\}/);
      expect(text).not.toMatch(/carpeta|folder|inbox|bandeja/i);
    }
    expect(seen.join('\n')).toContain('Sin proyecto');
  } finally {
    await end(session);
  }
});

test('14d. reduced motion removes the transitions of the cards and the disclosures', async () => {
  const root = newRoot();
  const session = await open(root);
  try {
    const { page, app } = session;
    await createProject(page, 'Calm');
    await goToProjects(page);
    const card = page.getByRole('article').first();
    const duration = (): Promise<number> =>
      card.evaluate((el) => Number.parseFloat(getComputedStyle(el).transitionDuration));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(duration).toBeCloseTo(0.15, 2);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(duration).toBeLessThan(0.001);

    await resize(app, 900, 820);
    await cardLink(page, 'Calm').click();
    const chevron = page.locator('summary svg').first();
    await expect
      .poll(() =>
        chevron.evaluate((el) => Number.parseFloat(getComputedStyle(el).transitionDuration)),
      )
      .toBeLessThan(0.001);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect
      .poll(() =>
        chevron.evaluate((el) => Number.parseFloat(getComputedStyle(el).transitionDuration)),
      )
      .toBeGreaterThan(0.1);
  } finally {
    await end(session);
  }
});
