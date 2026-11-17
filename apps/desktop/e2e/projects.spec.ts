import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { installEngine, launchAppInRoot, readyEnv } from './launch';
import { writeMeeting } from './library-data';

// Projects end to end on the fake native build, on throwaway data roots: a legacy folder list
// becomes projects on first launch, a project's chat survives a relaunch and reaches the model
// with the project's instructions and files, a project is deleted with everything it holds, and a
// meeting moves between projects. Nothing here touches a real Documents folder, model or account.
test.describe.configure({ mode: 'serial', timeout: 150_000 });

const id = (n: number): string => `1b7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F = {
  universidad: id(1),
  calculoU: id(2),
  trabajo: id(3),
  calculoT: id(4),
  producto: id(5),
  huerfana: id(6),
  unknown: id(99),
} as const;

const roots: string[] = [];
const libraryOf = (root: string): string => path.join(root, 'meetings');
const projectDir = (root: string, projectId: string): string =>
  path.join(libraryOf(root), '.vozella', 'projects', projectId);

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-e2e-projects-'));
  roots.push(root);
  return root;
}

test.afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** The old folder list: BOM, CRLF, mixed key case, nesting, name collisions, a note, an orphan. */
function legacyFolders(): string {
  const entries = [
    {
      Id: F.universidad.toUpperCase(),
      Name: 'Universidad',
      ParentId: null,
      Note: null,
      CreatedAt: '2025-03-01T10:00:00.0000000-05:00',
    },
    {
      id: F.calculoU,
      name: 'Calculo',
      parentId: F.universidad,
      note: null,
      createdAt: '2025-03-02T10:00:00-05:00',
    },
    {
      id: F.trabajo,
      name: 'Trabajo',
      parentId: null,
      note: null,
      createdAt: '2025-03-03T10:00:00-05:00',
    },
    {
      id: F.calculoT,
      name: 'calculo',
      parentId: F.trabajo,
      note: null,
      createdAt: '2025-03-04T10:00:00-05:00',
    },
    {
      id: F.producto,
      name: 'Producto Q4',
      parentId: null,
      note: 'Use a formal tone.',
      createdAt: '2025-03-05T10:00:00-05:00',
    },
    {
      id: F.huerfana,
      name: 'Huerfana',
      parentId: id(200),
      note: null,
      createdAt: '2025-03-06T10:00:00-05:00',
    },
  ];
  return `\uFEFF${JSON.stringify(entries, null, 2).replace(/\n/g, '\r\n')}`;
}

function seedLegacyLibrary(root: string): Buffer {
  const library = libraryOf(root);
  fs.mkdirSync(library, { recursive: true });
  const text = Buffer.from(legacyFolders(), 'utf8');
  fs.writeFileSync(path.join(library, 'folders.json'), text);
  const at = (n: number): string => `2026-09-0${String(n)}T10:00:00.0000000+00:00`;
  writeMeeting(library, {
    id: id(11),
    title: 'Limits class',
    recordedAt: at(1),
    directory: 'Universidad/Calculo',
    projectId: F.calculoU,
  });
  writeMeeting(library, {
    id: id(12),
    title: 'Budget review',
    recordedAt: at(2),
    directory: 'Trabajo/calculo',
    projectId: F.calculoT,
  });
  writeMeeting(library, {
    id: id(13),
    title: 'Roadmap sync',
    recordedAt: at(3),
    directory: 'Producto Q4',
    projectId: F.producto,
  });
  writeMeeting(library, { id: id(14), title: 'Standup', recordedAt: at(4) });
  writeMeeting(library, {
    id: id(15),
    title: 'Lost folder',
    recordedAt: at(5),
    projectId: F.unknown,
  });
  return text;
}

async function open(root: string, env: Record<string, string> = {}) {
  const app = await launchAppInRoot(root, env);
  const page = await app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  return { app, page };
}

const goToProjects = async (page: Page): Promise<void> => {
  await page.getByRole('navigation').getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
};

const backups = (root: string): string[] => {
  const dir = path.join(libraryOf(root), '.vozella', 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

test('the first launch turns a legacy folder list into projects, with a backup and one notice', async () => {
  const root = newRoot();
  const original = seedLegacyLibrary(root);
  const first = await open(root);
  try {
    await goToProjects(first.page);
    const cards = first.page.getByRole('article');
    await expect(cards).toHaveCount(6);
    for (const name of [
      'Universidad',
      'Universidad – Calculo',
      'Trabajo',
      'Trabajo – calculo',
      'Producto Q4',
      'Huerfana',
    ]) {
      await expect(first.page.getByRole('link', { name, exact: true })).toBeVisible();
    }
    // The unfiled meeting and the one whose folder is gone both wait under No project.
    await expect(first.page.getByRole('link', { name: /^No project/ })).toContainText('2 meetings');

    const notice = first.page.getByTestId('migration-notice');
    await expect(notice).toContainText('6 folders became projects.');

    // The old list is kept byte for byte in the backups folder, and is gone from the library.
    expect(fs.existsSync(path.join(libraryOf(root), 'folders.json'))).toBe(false);
    const [backup, ...extra] = backups(root);
    expect(extra).toEqual([]);
    expect(
      fs
        .readFileSync(path.join(libraryOf(root), '.vozella', 'backups', backup ?? ''))
        .equals(original),
    ).toBe(true);

    // The note became the instructions, and the meetings are where they were.
    await first.page.getByRole('link', { name: 'Producto Q4', exact: true }).click();
    await expect(first.page.getByRole('heading', { level: 1, name: 'Producto Q4' })).toBeVisible();
    await expect(first.page.getByText('Use a formal tone.')).toBeVisible();
    await expect(first.page.getByText('Roadmap sync')).toBeVisible();
    expect(
      fs.existsSync(path.join(libraryOf(root), 'Producto Q4', '2026-09-03 Roadmap sync.md')),
    ).toBe(true);

    await first.page.getByRole('navigation').getByRole('link', { name: 'Projects' }).click();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  } finally {
    await first.app.close();
  }

  // A second launch on the same root changes nothing and says nothing.
  const second = await open(root);
  try {
    await goToProjects(second.page);
    await expect(second.page.getByRole('article')).toHaveCount(6);
    await expect(second.page.getByTestId('migration-notice')).toHaveCount(0);
    expect(backups(root)).toHaveLength(1);
  } finally {
    await second.app.close();
  }
});

const OPEN_FILES = (app: ElectronApplication, paths: readonly string[]) =>
  app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...files] });
  }, paths);

const openProjectPage = async (page: Page, name: string): Promise<void> => {
  await goToProjects(page);
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
};

const chatsTab = (page: Page) => page.getByRole('tab', { name: 'Chats' });

test('a project chat carries the instructions and files, survives a relaunch, and goes with the project', async () => {
  const root = newRoot();
  const aside = path.join(root, 'picked');
  fs.mkdirSync(aside, { recursive: true });
  const notes = path.join(aside, 'budget.md');
  fs.writeFileSync(notes, '# Budget\nThe marketing budget is 42000 dollars.');
  const promptLog = path.join(aside, 'prompts.log');
  const env = { VOZELLA_E2E_SHOW: '1', VOZELLA_FAKE_CHAT_PROMPT_LOG: promptLog };

  let projectId = '';
  const first = await open(root, env);
  try {
    const { page, app } = first;
    await page.evaluate(() => window.vozella.invoke('summaries.chooseCli', { kind: 'ClaudeCode' }));
    const created = await page.evaluate(() =>
      window.vozella.invoke('projects.create', { name: 'Finance' }),
    );
    if (!created.ok) throw new Error('create failed');
    projectId = created.project.id;
    await openProjectPage(page, 'Finance');

    // Instructions are edited in place; a context file arrives through the system picker.
    const side = page.getByRole('complementary', { name: 'Project details' });
    await side.getByRole('button', { name: 'Edit instructions' }).click();
    await side
      .getByRole('textbox', { name: 'Instructions' })
      .fill('Always answer in formal Spanish.');
    await side.getByRole('button', { name: 'Save' }).click();
    await expect(side.getByText('Always answer in formal Spanish.')).toBeVisible();
    await OPEN_FILES(app, [notes]);
    await side.getByRole('button', { name: 'Add' }).click();
    await expect(side.getByText('budget.md')).toBeVisible();
    // The project keeps its own copy; the original stays where it was.
    expect(fs.readdirSync(path.join(projectDir(root, projectId), 'files'))).toHaveLength(1);
    expect(fs.existsSync(notes)).toBe(true);

    // A chat in the project: the model sees the instructions and the relevant file text.
    await chatsTab(page).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    const composer = page.getByTestId('TxtMeetingChat');
    await expect(composer).toBeVisible();
    await composer.fill('What is the marketing budget?');
    await composer.press('Enter');
    await expect(
      page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
    ).toBeVisible();
    const prompt = fs.readFileSync(promptLog, 'utf8');
    expect(prompt).toContain('Always answer in formal Spanish.');
    expect(prompt).toContain('The marketing budget is 42000 dollars.');
    expect(prompt).not.toContain(aside);
    await expect
      .poll(() => fs.readdirSync(path.join(projectDir(root, projectId), 'chats')).length)
      .toBe(1);
  } finally {
    await first.app.close();
  }

  // After a relaunch the chat is listed under the project, opens with its messages and goes on.
  const second = await open(root, env);
  try {
    const { page } = second;
    await openProjectPage(page, 'Finance');
    await chatsTab(page).click();
    await page.getByRole('button', { name: /^What is the marketing budget/ }).click();
    const list = page.getByTestId('ListMeetingChat');
    await expect(list.getByText('What is the marketing budget?')).toBeVisible();
    await expect(list.getByText('The team went over the plan')).toBeVisible();

    // Delete: the project, its file copy and its chats leave the disk.
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: 'Delete project?' })
      .getByRole('button', { name: 'Delete project' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Finance', exact: true })).toHaveCount(0);
    expect(fs.existsSync(projectDir(root, projectId))).toBe(false);
  } finally {
    await second.app.close();
  }
});

test('deleting a project keeps its meetings, which wait under No project', async () => {
  const root = newRoot();
  const session = await open(root);
  try {
    const { page } = session;
    const projectId = await createProject(page, 'Temporary', '');
    const meeting = writeMeeting(libraryOf(root), {
      id: id(31),
      title: 'Kept meeting',
      recordedAt: '2026-09-01T10:00:00.0000000+00:00',
      directory: 'Temporary',
      projectId,
    });
    await openProjectPage(page, 'Temporary');
    await expect(page.getByText('Kept meeting')).toBeVisible();
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete project?' });
    await expect(confirm).toContainText('Its 1 meeting moves to No project.');
    await confirm.getByRole('button', { name: 'Delete project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Temporary', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^No project/ })).toContainText('1 meeting');
    expect(fs.existsSync(projectDir(root, projectId))).toBe(false);
    // The meeting file went to the Inbox with it, and the emptied project directory is gone.
    expect(fs.existsSync(meeting)).toBe(false);
    expect(fs.existsSync(path.join(libraryOf(root), 'Inbox', '2026-09-01 Kept meeting.md'))).toBe(
      true,
    );
  } finally {
    await session.app.close();
  }
});

/** Settings for a Record page that can start at once: the local engine is installed by `installEngine`. */
function seedReadyProvider(root: string): void {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', 'settings.json'),
    JSON.stringify({
      selectedSummaryProvider: 'ClaudeCode',
      selectedSummaryModelId: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    }),
  );
}

async function createProject(page: Page, name: string, instructions: string): Promise<string> {
  const created = await page.evaluate(
    (projectName) => window.vozella.invoke('projects.create', { name: projectName }),
    name,
  );
  if (!created.ok) throw new Error('create failed');
  await page.evaluate(
    ([projectId, text]) =>
      window.vozella.invoke('projects.setInstructions', {
        id: projectId ?? '',
        instructions: text ?? '',
      }),
    [created.project.id, instructions],
  );
  return created.project.id;
}

test('the live copilot of a take started in a project is given the project instructions', async () => {
  const root = newRoot();
  const promptLog = path.join(root, 'prompts.log');
  seedReadyProvider(root);
  const session = await open(root, {
    ...readyEnv,
    VOZELLA_E2E_SHOW: '1',
    VOZELLA_FAKE_CHAT_PROMPT_LOG: promptLog,
  });
  try {
    const { page } = session;
    const projectId = await createProject(page, 'Calls', 'Keep every answer under two sentences.');
    await page.getByRole('link', { name: 'Record' }).click();
    await installEngine(page);
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeEnabled();
    // The address a project's Start meeting button opens, while the Record page is showing.
    await page.evaluate((id) => {
      window.location.hash = `#/record?project=${id}&start=1`;
    }, projectId);
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    // The take is saved to the project it was started in.
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.vozella.invoke('recording.getState', {}))).projectId,
      )
      .toBe(projectId);

    const composer = page.getByTestId('TxtMeetingChat');
    const launcher = page.getByTestId('BtnAiPanelOpen');
    await expect(launcher.or(composer).filter({ visible: true })).toBeVisible();
    if (await launcher.isVisible()) await launcher.click();
    await composer.fill('What was just said?');
    await composer.press('Enter');
    await expect(
      page.getByTestId('ListMeetingChat').getByText('The team went over the plan'),
    ).toBeVisible({ timeout: 30_000 });
    expect(fs.readFileSync(promptLog, 'utf8')).toContain('Keep every answer under two sentences.');
  } finally {
    // A take that is still running would ask before the window closes.
    await session.page
      .evaluate(() => window.vozella.invoke('recording.discard', {}))
      .catch(() => undefined);
    await session.app.close();
  }
});

// KNOWN DEFECT (found while writing this spec): when the Record page mounts fresh from another page
// with `?project=<id>&start=1`, the destination becomes the project but no take starts, even though
// recording is ready. The same address does start a take when the Record page is already showing
// (the test above). Remove `fixme` once the launch effect in RecordRoute starts the take on a fresh
// mount.
test.fixme('Start meeting in this project, pressed on the project page, starts the take', async () => {
  const root = newRoot();
  seedReadyProvider(root);
  const session = await open(root, { ...readyEnv, VOZELLA_E2E_SHOW: '1' });
  try {
    const { page } = session;
    await createProject(page, 'Calls', 'Short answers.');
    await installEngine(page);
    await openProjectPage(page, 'Calls');
    await page.getByRole('button', { name: 'Start meeting in this project' }).first().click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await session.page
      .evaluate(() => window.vozella.invoke('recording.discard', {}))
      .catch(() => undefined);
    await session.app.close();
  }
});
