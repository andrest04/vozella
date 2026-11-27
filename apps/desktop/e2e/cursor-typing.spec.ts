import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';
import {
  installEngine,
  launchApp,
  NO_TEST_HOOKS,
  openSettingsTab,
  packaged,
  readSettings,
  readyEnv,
  restoreMain,
  seedReadySettings,
  type LaunchedApp,
} from './launch';

// Type at cursor on the fake native build. The injector is the fake one aimed at a fake Notepad;
// the test-mode probe (`__vozellaCursorTypingProbe`, main process) reads what it typed and moves
// its foreground window. Arming goes through `cursorTyping.toggle`, the same path as the shortcut.
// The fake speech engine commits one phrase per 3 s of audio, cycling through its script.
//
// "Only the other participants" cannot be shown refusing the local user here: the fake capture
// gives the microphone and the output the same tone, so no frame is microphone-dominant and every
// line reads as the others'. The microphone rule is covered by the controller and typer unit
// tests; this spec covers the "Everything" source instead.

test.describe.configure({ mode: 'serial', timeout: 150_000 });
test.skip(packaged, NO_TEST_HOOKS);

/** The script of the fake speech engine (packages/platform/src/fakes/fake-asr-engine.ts). */
const PHRASES = [
  'Buenos días a todos y gracias por venir.',
  'Hoy revisamos el presupuesto del trimestre.',
  'Quedamos en cerrar las fechas de entrega esta semana.',
] as const;

type FakeForeground = 'notepad' | 'none' | 'own-window' | 'blocked' | 'other-window';

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp(readyEnv, seedReadySettings);
  page = await launched.app.firstWindow();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.getByRole('link', { name: 'Record' }).click();
  await installEngine(page);
});

test.afterAll(async () => {
  await page.evaluate(() => window.vozella.invoke('recording.discard', {})).catch(() => undefined);
  await launched.close();
});

// ---------------------------------------------------------------- probe and IPC

async function typed(): Promise<string[]> {
  return launched.app.evaluate(() => {
    const probe = (globalThis as unknown as Record<string, unknown>).__vozellaCursorTypingProbe as
      { typed: () => string[] } | undefined;
    if (!probe) throw new Error('no type at cursor probe: not a test-mode fake native build');
    return probe.typed();
  });
}

async function clearTyped(): Promise<void> {
  await launched.app.evaluate(() => {
    const probe = (globalThis as unknown as Record<string, unknown>).__vozellaCursorTypingProbe as {
      clearTyped: () => void;
    };
    probe.clearTyped();
  });
}

async function setForeground(foreground: FakeForeground): Promise<void> {
  await launched.app.evaluate((_electron, name) => {
    const probe = (globalThis as unknown as Record<string, unknown>).__vozellaCursorTypingProbe as {
      setForeground: (foreground: string) => void;
    };
    probe.setForeground(name);
  }, foreground);
}

const toggle = () => page.evaluate(() => window.vozella.invoke('cursorTyping.toggle', {}));

const typingState = () => page.evaluate(() => window.vozella.invoke('cursorTyping.getState', {}));

const recordingState = () => page.evaluate(() => window.vozella.invoke('recording.getState', {}));

/** Committed lines of the take: a line that ends with a whole phrase (an interim never does). */
async function committedCount(): Promise<number> {
  const { liveText } = await recordingState();
  return liveText
    .split(/\r?\n/)
    .filter((line) => PHRASES.some((phrase) => line.trimEnd().endsWith(phrase))).length;
}

/**
 * True when the typed segments are the script read on from committed line `k`, for some `k` from
 * `from` to `to`: in order, nothing skipped, nothing from before the arming.
 */
function continuesScript(segments: readonly string[], from: number, to: number): boolean {
  for (let k = from; k <= to; k += 1) {
    if (segments.every((segment, j) => segment === PHRASES[(k + j) % PHRASES.length])) return true;
  }
  return false;
}

/** Lines are joined with one space and never carry a newline (Enter would send the message). */
function expectJoinedWithSpaces(chunks: readonly string[]): string[] {
  const segments = chunks.map((chunk) => chunk.trim());
  expect(chunks.join('')).toBe(segments.join(' '));
  expect(chunks.join('')).not.toMatch(/[\r\n]/);
  return segments;
}

// ---------------------------------------------------------------- takes and the pill

async function startTake(title: string): Promise<void> {
  const started = await page.evaluate(
    (name) =>
      window.vozella.invoke('recording.start', {
        title: name,
        projectId: null,
        microphone: { kind: 'SystemDefault', deviceId: null },
        appName: null,
      }),
    title,
  );
  expect(started).toMatchObject({ started: true });
  await expect
    .poll(async () => (await recordingState()).phase, { timeout: 30_000 })
    .toBe('Recording');
}

async function discardTake(): Promise<void> {
  await page.evaluate(() => window.vozella.invoke('recording.discard', {}));
  await expect.poll(async () => (await recordingState()).phase, { timeout: 30_000 }).toBe('Idle');
}

async function pillPage(): Promise<Page> {
  const find = () => launched.app.windows().find((p) => p.url().endsWith('/pill.html'));
  await expect.poll(() => find() !== undefined, { timeout: 15_000 }).toBe(true);
  const pill = find();
  if (!pill) throw new Error('no pill page');
  return pill;
}

/** Arms on the fake Notepad and returns the committed count before and after the press. */
async function arm(source: 'others' | 'all' = 'others'): Promise<{ from: number; to: number }> {
  const from = await committedCount();
  const result = await toggle();
  const to = await committedCount();
  expect(result.arm).toEqual({ ok: true });
  expect(result.status.state).toMatchObject({
    status: 'armed',
    source,
    processName: 'notepad.exe',
  });
  return { from, to };
}

// ---------------------------------------------------------------- scenarios

test('armed, it types the new lines of the others in order, one space apart', async () => {
  await startTake('Type at cursor');
  await expect.poll(committedCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await clearTyped();
  const { from, to } = await arm();
  const pill = await pillPage();
  const badge = pill.getByTestId('pill-cursor-typing-badge');
  await expect(badge).toHaveAttribute('data-mode', 'armed');
  await expect(badge).toHaveAttribute('title', 'Typing into Notepad');

  await expect
    .poll(async () => (await typed()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  const segments = expectJoinedWithSpaces(await typed());
  // The lines said before the press are not typed: the first typed one comes after them.
  expect(from).toBeGreaterThanOrEqual(1);
  expect(continuesScript(segments, from, to)).toBe(true);
  // Every line read as the others', so nothing warned about the speaker.
  await expect(badge).toHaveAttribute('data-mode', 'armed');
  await discardTake();
});

test('with the source on Everything, every new line is typed', async () => {
  await page.evaluate(() =>
    window.vozella.invoke('settings.update', { patch: { cursorTypingSource: 'all' } }),
  );
  // Main reads the saved source right after the save, long before the take is recording.
  await startTake('Type everything');
  await clearTyped();
  const { from, to } = await arm('all');

  await expect
    .poll(async () => (await typed()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  expect(continuesScript(expectJoinedWithSpaces(await typed()), from, to)).toBe(true);
  await discardTake();
  await page.evaluate(() =>
    window.vozella.invoke('settings.update', { patch: { cursorTypingSource: null } }),
  );
});

test('another window in front pauses typing; coming back types the queued line', async () => {
  await startTake('Focus change');
  // Nothing safe to type into: no window, Vozella itself, an administrator window.
  const refusals: [FakeForeground, string][] = [
    ['none', 'no-target'],
    ['own-window', 'own-window'],
    ['blocked', 'blocked'],
  ];
  for (const [foreground, reason] of refusals) {
    await setForeground(foreground);
    const refused = await toggle();
    expect(refused.arm, foreground).toEqual({ ok: false, reason });
    expect(refused.status.state).toEqual({ status: 'off' });
  }
  await setForeground('notepad');
  await clearTyped();
  const { from, to } = await arm();
  const badge = (await pillPage()).getByTestId('pill-cursor-typing-badge');
  await expect
    .poll(async () => (await typed()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  await setForeground('other-window');
  // The next line finds the other window and waits.
  await expect(badge).toHaveAttribute('data-mode', 'paused', { timeout: 15_000 });
  await expect(badge).toHaveAttribute('title', 'Paused: go back to Notepad to continue');
  const whilePaused = (await typed()).length;
  const committed = await committedCount();
  await expect.poll(committedCount, { timeout: 15_000 }).toBeGreaterThan(committed);
  expect(await typed()).toHaveLength(whilePaused);

  await setForeground('notepad');
  await expect
    .poll(async () => (await typed()).length, { timeout: 15_000 })
    .toBeGreaterThan(whilePaused);
  await expect(badge).toHaveAttribute('data-mode', 'armed');
  // Nothing was lost or doubled: the queued line came next in the script.
  expect(continuesScript(expectJoinedWithSpaces(await typed()), from, to)).toBe(true);
  await discardTake();
});

test('Stop disarms, and the lines that drain after it are not typed', async () => {
  await startTake('Stop disarms');
  await clearTyped();
  await arm();
  const badge = (await pillPage()).getByTestId('pill-cursor-typing-badge');
  await expect(badge).toHaveAttribute('data-mode', 'armed');
  await expect
    .poll(async () => (await typed()).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  await page.evaluate(() => window.vozella.invoke('recording.stop', {}));
  await expect(badge).toHaveCount(0, { timeout: 15_000 });
  expect((await typingState()).state).toEqual({ status: 'off' });
  const atStop = (await typed()).length;
  // Once the take left Stopping the live pass is closed and drained: nothing more can come.
  await expect
    .poll(async () => (await recordingState()).phase, { timeout: 60_000 })
    .not.toMatch(/^(Recording|Stopping)$/);
  expect(await typed()).toHaveLength(atStop);
});

test('a press without a recording is refused, and a second one says so again', async () => {
  const note = (await pillPage()).getByTestId('pill-cursor-typing-note');

  const first = await toggle();
  expect(first.arm).toEqual({ ok: false, reason: 'inactive' });
  expect(first.status.lastRefusal).toBe('inactive');
  await expect(note).toHaveText('Start a recording first');
  // The note goes after about 4 s; the same refusal must bring it back.
  await expect(note).toHaveCount(0, { timeout: 10_000 });

  const second = await toggle();
  expect(second.arm).toEqual({ ok: false, reason: 'inactive' });
  expect(second.status.refusalSeq).toBe((first.status.refusalSeq ?? 0) + 1);
  await expect(note).toHaveText('Start a recording first');
});

test('Settings: the section is accessible and its choices survive a reload', async () => {
  await restoreMain(launched.app);
  await page.getByRole('link', { name: 'Settings' }).click();
  await openSettingsTab(page, 'recording');
  const section = page.getByTestId('cursor-typing-section');
  await expect(section.getByRole('heading', { level: 2, name: 'Type at cursor' })).toBeVisible();
  const toggleSwitch = section.getByRole('switch', { name: 'Type what they say into any app' });
  const source = section.getByRole('combobox', { name: 'What to type' });
  await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(source).toContainText('Only the other participants');

  // Axe reads computed colors: finish the fades first, as the other settings specs do.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
    }
  });
  await page.evaluate(axe.source);
  const serious = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        axe: {
          run: (
            context: string,
          ) => Promise<{ violations: { id: string; impact: string | null }[] }>;
        };
      }
    ).axe;
    const result = await api.run('[data-testid="cursor-typing-section"]');
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  });
  expect(serious).toEqual([]);

  await source.click();
  await page.getByRole('option', { name: 'Everything', exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect.poll(() => readSettings(launched.dataRoot).cursorTypingSource).toBe('all');
  await toggleSwitch.click();
  await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => readSettings(launched.dataRoot).cursorTypingEnabled).toBe(false);

  await page.reload();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await openSettingsTab(page, 'recording');
  await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(source).toContainText('Everything');
  // Off, the other controls wait for the switch.
  await expect(source).toBeDisabled();
});
