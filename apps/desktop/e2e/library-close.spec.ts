import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './launch';

/** Posts WM_CLOSE to every top-level window of a process, as the title bar's X does. */
const POST_WM_CLOSE = (pid: number | undefined): string => `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Close(uint pid) {
    int n = 0;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == pid && PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero)) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
[W]::Close(${String(pid)})
`;

// B16: instructions saved just before the last window closes must have reached the project's file.
/** Saves instructions on a new project's page, and returns where the project keeps them. */
async function saveInstructions(
  page: Page,
  dataRoot: string,
  name: string,
  text: string,
): Promise<string> {
  const created = await page.evaluate(
    (projectName) => window.vozella.invoke('projects.create', { name: projectName }),
    name,
  );
  if (!created.ok) throw new Error('create failed');
  await page.getByRole('link', { name: /Projects|Proyectos/ }).click();
  await page.getByRole('article').getByRole('link', { name, exact: true }).click();
  const side = page.getByRole('complementary', { name: 'Project details' });
  await side.getByRole('button', { name: 'Edit instructions' }).click();
  await side.getByRole('textbox', { name: 'Instructions' }).fill(text);
  await side.getByRole('button', { name: 'Save' }).click();
  await expect(side.getByText(text)).toBeVisible();
  return path.join(
    dataRoot,
    'meetings',
    '.vozella',
    'projects',
    created.project.id,
    'project.json',
  );
}

test.describe.configure({ timeout: 90_000 });

test('instructions saved right before the window closes are kept', async () => {
  const launched = await launchApp({ VOZELLA_E2E_SHOW: '1' });
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByRole('navigation')).toBeVisible();
    const file = await saveInstructions(
      page,
      launched.dataRoot,
      'Alpha',
      'saved just before close',
    );

    const exited = new Promise<void>((resolve) => {
      launched.app.process().once('exit', () => {
        resolve();
      });
    });
    await launched.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close();
    });
    await exited;

    expect(fs.readFileSync(file, 'utf8')).toContain('saved just before close');
  } finally {
    fs.rmSync(launched.dataRoot, { recursive: true, force: true });
  }
});

// Item 110: the window's own close button sends WM_CLOSE to the window. `Process.CloseMainWindow`
// posts exactly that message to the process's main window, so this is the same path as a
// click on the title bar's X, unlike BrowserWindow.close() which skips the OS message.
test('instructions saved right before the close button is pressed are kept', async () => {
  test.skip(process.platform !== 'win32', 'WM_CLOSE is a Windows message');
  const launched = await launchApp({ VOZELLA_E2E_SHOW: '1' });
  try {
    const page = await launched.app.firstWindow();
    await expect(page.getByRole('navigation')).toBeVisible();
    const file = await saveInstructions(page, launched.dataRoot, 'Beta', 'saved before the X');

    const pid = launched.app.process().pid;
    expect(pid).toBeGreaterThan(0);
    const exited = new Promise<void>((resolve) => {
      launched.app.process().once('exit', () => {
        resolve();
      });
    });
    const closed = execFileSync('powershell.exe', ['-NoProfile', '-Command', POST_WM_CLOSE(pid)], {
      encoding: 'utf8',
    });
    if (Number(closed.trim()) === 0) {
      // No desktop window to receive the message (a session without an interactive desktop).
      await launched.app.close();
      test.skip(true, 'no top-level window was reachable to receive WM_CLOSE');
    }
    await exited;

    expect(fs.readFileSync(file, 'utf8')).toContain('saved before the X');
  } finally {
    try {
      fs.rmSync(launched.dataRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    } catch {
      // A helper process of the closed app can hold the folder a moment; it is only a temp folder.
    }
  }
});
