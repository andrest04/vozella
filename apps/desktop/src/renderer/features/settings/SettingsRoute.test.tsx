// @vitest-environment jsdom
import type { SettingsPageDto } from '@vozella/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../app/theme';
import { Providers } from '../../app/test-providers';
import { SettingsRoute } from './SettingsRoute';
import { resetSettingsPageCache } from './use-settings-page';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const model = (fileName: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  fileName,
  displayName,
  vendor: 'Google',
  fileSizeGb: 3.11,
  minRamGb: 6,
  speedKey: 'ModelSpeedFast',
  qualityKey: 'ModelQualityVeryGood',
  useCaseKey: 'ModelUseCaseRecommendedDefault',
  fit: 'Recommended',
  recommended: false,
  legacy: false,
  downloaded: false,
  active: false,
  downloading: false,
  percent: null,
  ...extra,
});

/** Every engine's readiness, in display order, as T1's page answer lists them. */
const ENGINES = [
  { kind: 'Local', readiness: 'needs-model', model: null },
  { kind: 'ClaudeCode', readiness: 'ready', model: 'sonnet' },
  { kind: 'Codex', readiness: 'ready', model: 'gpt-5.6' },
  { kind: 'OpenAi', readiness: 'needs-key', model: 'gpt-5-mini' },
  { kind: 'Anthropic', readiness: 'needs-key', model: 'claude-sonnet-5-5' },
  { kind: 'Gemini', readiness: 'needs-key', model: 'gemini-2.5-flash' },
  { kind: 'OpenAiCompatible', readiness: 'needs-server', model: null },
] as const;

const engines = (readiness: Record<string, string> = {}) =>
  ENGINES.map((engine) => ({ ...engine, readiness: readiness[engine.kind] ?? engine.readiness }));

const apiEngine = (extra: Record<string, unknown> = {}) => ({
  keySet: false,
  model: 'gpt-5-mini',
  modelOptions: ['gpt-5-mini'],
  modelLabels: {},
  baseUrl: null,
  ...extra,
});

function pageDto(extra: Record<string, unknown> = {}): SettingsPageDto {
  return {
    settings: {},
    uiLanguage: 'en-US',
    provider: 'Local',
    api: {
      OpenAi: apiEngine(),
      Anthropic: apiEngine({ model: 'claude-sonnet-5-5', modelOptions: ['claude-sonnet-5-5'] }),
      Gemini: apiEngine({ model: 'gemini-2.5-flash', modelOptions: ['gemini-2.5-flash'] }),
      OpenAiCompatible: apiEngine({ model: '', modelOptions: [] }),
    },
    claude: {
      model: 'sonnet',
      effort: 'low',
      modelOptions: ['sonnet', 'opus'],
      effortOptions: ['low', 'high'],
    },
    codex: {
      model: 'gpt-5.6',
      effort: 'low',
      modelOptions: ['gpt-5.6'],
      effortOptions: ['low'],
    },
    cliStatus: null,
    engines: engines(),
    transcriptionLanguage: 'es',
    summaryLanguage: 'es',
    hardware: { totalRamGb: 16, gpuName: null, gpuVramGb: null },
    models: {
      rows: [model('a.gguf', 'Model A'), model('b.gguf', 'Model B', { downloaded: true })],
      missingActiveId: null,
    },
    providerNotice: null,
    capabilities: { localModels: true },
    notices: [],
    ...extra,
  } as unknown as SettingsPageDto;
}

/** The engine list: one disclosure button per engine, named by the engine. */
const engineList = (name = 'Choose where summaries are generated') =>
  screen.findByRole('group', { name });
const rowsOf = (list: HTMLElement): HTMLElement[] =>
  within(list)
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded'));
const row = (name: string | RegExp) => screen.findByRole('button', { name });
const openRow = (name: string | RegExp) => screen.findByRole('button', { name, expanded: true });
/** The setup panel a row button controls. */
const panelOf = (button: HTMLElement): HTMLElement => {
  const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (panel === null) throw new Error('no panel for the row');
  return panel;
};
/** Opens the local model list from the Local row and answers its radio group. */
const openModels = async (): Promise<HTMLElement> => {
  await userEvent.click(await screen.findByRole('button', { name: 'Change model' }));
  const dialog = await screen.findByRole('dialog', { name: 'Summary models' });
  return within(dialog).getByRole('radiogroup', { name: 'Summary models' });
};
const modelsDialog = () => screen.getByRole('dialog', { name: 'Summary models' });
/** Waits until the named engine's row says it is the one in use. */
const inUse = async (name: string | RegExp): Promise<void> => {
  await waitFor(() => {
    expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(/In use/);
  });
};

const allOn = { localModels: true };

type Handler = (input: unknown) => unknown;
const listeners = new Map<string, (payload: unknown) => void>();
const everyListener = new Set<[string, (payload: unknown) => void]>();
const emit = (name: string, payload: unknown) => {
  for (const [target, listener] of everyListener) if (target === name) listener(payload);
};

function install(handlers: Record<string, Handler>) {
  const calls: { name: string; input: unknown }[] = [];
  const api = {
    invoke: vi.fn((name: string, input: unknown) => {
      calls.push({ name, input });
      const handler = handlers[name];
      if (!handler) {
        if (name === 'library.getLocation') return new Promise(() => undefined);
        return Promise.reject(new Error(`unhandled ${name}`));
      }
      try {
        return Promise.resolve(handler(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }),
    on: (name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      const entry: [string, (payload: unknown) => void] = [name, listener];
      everyListener.add(entry);
      return () => {
        listeners.delete(name);
        everyListener.delete(entry);
      };
    },
  };
  Object.defineProperty(window, 'vozella', { value: api, configurable: true, writable: true });
  return calls;
}

const mount = (locale: 'en' | 'es' = 'en') =>
  render(
    <ThemeProvider>
      <Providers locale={locale}>
        <SettingsRoute />
      </Providers>
    </ThemeProvider>,
  );

beforeEach(() => {
  resetSettingsPageCache();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  listeners.clear();
});

describe('Settings page', () => {
  it('shows why the page could not load and tries again, instead of showing defaults', async () => {
    let attempt = 0;
    install({
      'settings.getPage': () => {
        attempt += 1;
        if (attempt === 1) throw new Error('disk unreadable');
        return pageDto();
      },
    });
    mount();
    expect(
      await screen.findByText('The settings could not be loaded. disk unreadable'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await inUse('Local (on this device)');
  });

  it('draws only the controls whose module is present', async () => {
    install({
      'settings.getPage': () => pageDto({ capabilities: { localModels: false } }),
    });
    mount();
    await inUse('Local (on this device)');
    expect(await openRow('Local (on this device)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('asks for another provider when the saved one is the removed Grok, and offers no Grok row', async () => {
    install({
      'settings.getPage': () => pageDto({ provider: 'Xai', providerNotice: 'xai-removed' }),
    });
    mount();
    expect(
      await screen.findByText(
        'Grok (xAI) is no longer available. Pick Local, Claude Code, Codex or an API key engine to summarize your meetings.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Grok/ })).toBeNull();
    const rows = rowsOf(await engineList());
    expect(rows).toHaveLength(7);
    for (const button of rows) {
      expect(button).not.toHaveAccessibleDescription(/In use/);
      // Nothing is in use, so nothing opens on its own.
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByRole('textbox', { name: 'API key' })).toBeNull();
    expect(screen.queryByText('Not signed in')).toBeNull();
  });

  it('shows the notice in Spanish and clears it when another provider is picked', async () => {
    let saved = false;
    install({
      'settings.getPage': () =>
        saved
          ? pageDto({ provider: 'Codex' })
          : pageDto({ provider: 'Xai', providerNotice: 'xai-removed' }),
      'settings.setSummaryProvider': () => {
        saved = true;
        return { status: 'saved', settings: {}, feedback: null };
      },
    });
    mount('es');
    expect(
      await screen.findByText(
        'Grok (xAI) ya no está disponible. Elige Local, Claude Code, Codex o un motor con clave de API para resumir tus reuniones.',
      ),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'CLI de Codex' }));
    await user.click(screen.getByRole('button', { name: 'Usar este motor' }));
    await waitFor(() => {
      expect(screen.queryByText(/Grok \(xAI\) ya no está disponible/)).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'CLI de Codex' })).toHaveAccessibleDescription(
      /En uso/,
    );
  });

  it('offers Set up when no model is active, and it opens the wizard on the hardware step (S20)', async () => {
    let closed = 0;
    install({
      'settings.getPage': () => {
        closed += 1;
        return pageDto();
      },
      'summaries.hardware': () => new Promise(() => undefined),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('dialog', { name: 'Set up summary generation' })).toBeVisible();
    expect(screen.getByText('Detecting hardware...')).toBeVisible();
    expect(screen.queryByText('Choose how to generate summaries')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Leaving the wizard reads the page again, so a model chosen there shows at once.
    expect(closed).toBeGreaterThan(1);
  });

  it('keeps Set up as the only primary action beside the Download buttons', async () => {
    install({ 'settings.getPage': () => pageDto() });
    mount();
    const setUp = await screen.findByRole('button', { name: 'Set up' });
    expect(setUp).toHaveClass('bg-ink');
    const group = await openModels();
    for (const button of within(group).getAllByRole('button')) {
      expect(button).not.toHaveClass('bg-ink');
    }
  });

  it('badges only the model recommended for this PC, shows vendors and the legacy model', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [
              model('a.gguf', 'Model A', { vendor: 'IBM' }),
              model('c.gguf', 'Model C', { vendor: 'Alibaba', recommended: true }),
              model('e2b.gguf', 'Old model', {
                vendor: 'Google',
                legacy: true,
                downloaded: true,
                active: true,
                useCaseKey: 'Ui_ModelUseCaseLegacy',
              }),
            ],
            missingActiveId: null,
          },
        }),
    });
    mount();
    const group = await openModels();
    expect(within(group).getAllByText('Recommended for your PC')).toHaveLength(1);
    const picked = within(group).getByRole('radio', { name: /Model C/ });
    expect(picked).toHaveAccessibleName(/Recommended for your PC/);
    // The pick replaces its "runs well" label; the other rows keep their fit label.
    expect(picked).not.toHaveAccessibleName(/Runs well on this PC/);
    expect(within(group).getByRole('radio', { name: /Model A/ })).toHaveAccessibleName(
      /Runs well on this PC/,
    );
    for (const vendor of ['IBM', 'Alibaba', 'Google']) {
      expect(within(group).getByText(vendor)).toBeVisible();
    }
    const legacy = within(group).getByRole('radio', { name: /Old model/ });
    expect(legacy).toBeChecked();
    expect(legacy).toHaveAccessibleName(/Previous model/);
    expect(legacy).not.toHaveAccessibleName(/Recommended for your PC/);
    expect(
      within(group).getByText('Previous model, kept because it is already on this PC'),
    ).toBeVisible();
    expect(within(group).getByRole('button', { name: 'Delete Old model' })).toBeVisible();
  });

  it('hides Set up once a model is active, and for the CLI providers (S20)', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [model('b.gguf', 'Model B', { downloaded: true, active: true })],
            missingActiveId: null,
          },
        }),
    });
    mount();
    expect(await screen.findByRole('button', { name: 'Change model' })).toBeVisible();
    expect(screen.getByText('Model B')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('saves one field, shows the saved bar, and sends nothing for the value already shown (174, 175)', async () => {
    const calls = install({
      'settings.getPage': () => pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' }),
      'settings.setCliOption': () => ({
        status: 'saved',
        settings: {},
        feedback: { key: 'Xai_FeedbackModel', args: ['sonnet · high'] },
      }),
    });
    mount();
    const user = userEvent.setup();
    await screen.findByText('Detected on PATH.');
    await user.click(screen.getByRole('combobox', { name: 'Effort' }));
    await user.click(await screen.findByRole('option', { name: 'low' }));
    expect(calls.filter((c) => c.name === 'settings.setCliOption')).toHaveLength(0);

    await user.click(screen.getByRole('combobox', { name: 'Effort' }));
    await user.click(await screen.findByRole('option', { name: 'high' }));
    expect(await screen.findByText('Saved. Using sonnet · high.')).toBeInTheDocument();
    expect(calls.filter((c) => c.name === 'settings.setCliOption').map((c) => c.input)).toEqual([
      { provider: 'claude', field: 'effort', value: 'high' },
    ]);
  });

  it('puts a control back and says so when a change is not saved', async () => {
    install({
      'settings.getPage': () => pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' }),
      'settings.setCliOption': () => ({ status: 'failed', message: 'read-only disk' }),
    });
    mount();
    const user = userEvent.setup();
    await screen.findByText('Detected on PATH.');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'opus' }));
    expect(
      await screen.findByText('This setting was not saved. read-only disk'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('sonnet');
  });

  it('shows a download as it runs, then the failure with the model name', async () => {
    let finish: (value: unknown) => void = () => undefined;
    install({
      'settings.getPage': () => pageDto(),
      'settings.models.download': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    mount();
    const user = userEvent.setup();
    const group = await openModels();
    expect(within(group).getByRole('radio', { name: /Model A/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(group).getByRole('radio', { name: /Model B/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      within(group).getAllByText('Fast · Quality Very good · 3.1 GB download', { exact: false })[0],
    ).toBeInTheDocument();
    expect(within(group).getAllByText('Runs well on this PC')).toHaveLength(2);
    expect(within(group).queryByText('Recommended')).toBeNull();
    // A model that is not on this PC says why it cannot be picked, not only by being disabled.
    expect(within(group).getAllByText('Download to use')).toHaveLength(1);
    expect(within(group).getByRole('radio', { name: /Model A/ })).toHaveAccessibleName(
      /Download to use/,
    );
    expect(within(group).getByRole('radio', { name: /Model B/ })).not.toHaveAccessibleName(
      /Download to use/,
    );

    await user.click(within(group).getByRole('button', { name: 'Download' }));
    expect(
      await within(group).findByRole('button', { name: 'Cancel download' }),
    ).toBeInTheDocument();
    act(() => {
      listeners.get('settings.modelEvent')?.({ type: 'progress', fileName: 'a.gguf', percent: 42 });
    });
    expect(await within(group).findByRole('progressbar', { name: 'Downloading' })).toHaveAttribute(
      'aria-valuenow',
      '42',
    );
    await act(async () => {
      finish({ status: 'failed', message: 'offline' });
      await Promise.resolve();
    });
    expect(
      await within(modelsDialog()).findByText('Could not download Model A. offline'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(within(group).queryByRole('button', { name: 'Cancel download' })).toBeNull();
    });
  });

  it('names a missing active model and keeps Delete working', async () => {
    const calls = install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [model('b.gguf', 'Model B', { downloaded: true })],
            missingActiveId: 'gone.gguf',
          },
        }),
      'settings.models.delete': () => ({ status: 'busy' }),
    });
    mount();
    expect(
      await screen.findByText(/gone\.gguf is not on this PC|selected model gone\.gguf/),
    ).toBeInTheDocument();
    await openModels();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Model B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Model B?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await within(modelsDialog()).findByText('Model B is downloading. Cancel the download first.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.name === 'settings.models.delete')).toBe(true);
  });

  it('asks before deleting a model: Cancel keeps it, Delete removes it and says so', async () => {
    let deleted = false;
    const calls = install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [model('b.gguf', 'Model B', { downloaded: !deleted })],
            missingActiveId: null,
          },
        }),
      'settings.models.delete': () => {
        deleted = true;
        return { status: 'deleted', settings: {} };
      },
    });
    mount();
    const user = userEvent.setup();
    await openModels();
    const trigger = await screen.findByRole('button', { name: 'Delete Model B' });
    // The trigger is quiet, so it does not read like Download.
    expect(trigger).toHaveClass('bg-transparent');

    await user.click(trigger);
    let dialog = await screen.findByRole('dialog', { name: 'Delete Model B?' });
    // Cancel takes the focus once the dialog has opened, so Enter never deletes.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete Model B?' })).toBeNull();
    });
    // The confirmation sits on the model list, which stays open.
    expect(modelsDialog()).toBeVisible();
    expect(calls.some((call) => call.name === 'settings.models.delete')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete Model B' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete Model B?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveClass('bg-ink');
    await user.click(confirm);
    expect(calls.find((call) => call.name === 'settings.models.delete')?.input).toEqual({
      fileName: 'b.gguf',
    });
    expect(await screen.findByText('Model B deleted.')).toBeInTheDocument();
  });

  it('shows the recovered settings notice and dismisses it', async () => {
    const calls = install({
      'settings.getPage': () =>
        pageDto({
          notices: [
            {
              id: 'settings-recovered',
              kind: 'settings-recovered',
              keptAs: 'C:/x/settings.json.corrupt',
            },
          ],
        }),
      'settings.dismissNotice': () => ({ dismissed: true }),
    });
    mount();
    const notice = await screen.findByText(/settings\.json\.corrupt/);
    expect(notice).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(calls.some((call) => call.name === 'settings.dismissNotice')).toBe(true);
    });
  });

  it('closes the saved bar after 4 seconds, and a newer message restarts the clock', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      install({
        'settings.getPage': () => pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' }),
        'settings.setCliOption': () => {
          n += 1;
          return {
            status: 'saved',
            settings: {},
            feedback: { key: 'Xai_FeedbackModel', args: [`message ${n.toString()}`] },
          };
        },
      });
      mount();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      await screen.findByText('Detected on PATH.');
      await user.click(screen.getByRole('combobox', { name: 'Model' }));
      await user.click(await screen.findByRole('option', { name: 'opus' }));
      expect(await screen.findByText('Saved. Using message 1.')).toBeInTheDocument();

      // Three seconds in, a second message arrives and takes over the single timer.
      await act(() => vi.advanceTimersByTimeAsync(3000));
      await user.click(screen.getByRole('combobox', { name: 'Effort' }));
      await user.click(await screen.findByRole('option', { name: 'high' }));
      expect(await screen.findByText('Saved. Using message 2.')).toBeInTheDocument();

      // Past the first message's 4 seconds the newer one is still there.
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(screen.getByText('Saved. Using message 2.')).toBeInTheDocument();
      // Four seconds after the second message it closes.
      await act(() => vi.advanceTimersByTimeAsync(1100));
      expect(screen.queryByText(/Saved\. Using message/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the app language, opens the restart prompt, and Later closes it without restarting', async () => {
    const calls = install({
      'settings.getPage': () => pageDto(),
      'settings.setUiLanguage': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'App language' }));
    await user.click(await screen.findByRole('option', { name: 'Español' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart required' });
    await user.click(within(dialog).getByRole('button', { name: 'Later' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(calls.some((call) => call.name === 'app.restart')).toBe(false);
    expect(calls.find((call) => call.name === 'settings.setUiLanguage')?.input).toEqual({
      tag: 'es',
    });
  });

  it('shows a refused restart as nothing and a failed one in words', async () => {
    install({
      'settings.getPage': () => pageDto(),
      'settings.setUiLanguage': () => ({ status: 'saved', settings: {}, feedback: null }),
      'app.restart': () => ({ status: 'failed', message: 'blocked' }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'App language' }));
    await user.click(await screen.findByRole('option', { name: 'Español' }));
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    expect(await screen.findByText('Vozella could not restart. blocked')).toBeInTheDocument();
  });

  it('shows the skeleton and no control while the first answer is pending (8.3)', async () => {
    let answer: (value: unknown) => void = () => undefined;
    install({
      'settings.getPage': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    mount();
    expect(screen.getByLabelText('Loading settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Local (on this device)' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'App language' })).toBeNull();
    await act(async () => {
      answer(pageDto());
      await Promise.resolve();
    });
    await inUse('Local (on this device)');
    expect(screen.queryByLabelText('Loading settings')).toBeNull();
  });

  it('draws the blocks in meeting lifecycle order under the page title (8.1, 8.2)', async () => {
    install({ 'settings.getPage': () => pageDto() });
    mount();
    await row('Local (on this device)');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const wanted = [
      'Microphone',
      'Meeting language',
      'Transcription',
      'Summary provider',
      'Appearance',
      'Language',
      'Data',
      'About',
    ];
    const seen = screen
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
      .filter((text) => wanted.includes(text));
    expect(seen).toEqual(wanted);
  });

  it('leaving before the first answer applies nothing and starts nothing (8.7)', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const calls = install({
      'settings.getPage': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const view = mount();
    view.unmount();
    await act(async () => {
      answer(pageDto());
      await Promise.resolve();
    });
    const names = calls
      .map((call) => call.name)
      .filter((name) => name !== 'library.getLocation' && name !== 'app.setThemePreference');
    expect(names).toEqual(['settings.getPage']);
  });

  it('opening the page never writes (8.8, 8.11)', async () => {
    const calls = install({ 'settings.getPage': () => pageDto() });
    mount();
    await row('Local (on this device)');
    const writes = calls.filter((call) =>
      /^settings\.(set|models\.(select|delete))/.test(call.name),
    );
    expect(writes).toEqual([]);
  });

  it('a revisit paints the last answer at once and refreshes without the skeleton (8.4)', async () => {
    let second: (value: unknown) => void = () => undefined;
    let n = 0;
    install({
      'settings.getPage': () => {
        n += 1;
        if (n === 1) return pageDto();
        return new Promise((resolve) => {
          second = resolve;
        });
      },
    });
    const first = mount();
    await row('Local (on this device)');
    first.unmount();
    mount();
    expect(
      screen.getByRole('button', { name: 'Local (on this device)' }),
    ).toHaveAccessibleDescription(/In use/);
    expect(screen.queryByLabelText('Loading settings')).toBeNull();
    await act(async () => {
      second(pageDto({ provider: 'Codex' }));
      await Promise.resolve();
    });
    await inUse('Codex CLI');
  });

  it('overlapping loads: the newest answer wins even when the older one lands last (7.17)', async () => {
    const pending: ((value: unknown) => void)[] = [];
    install({
      'settings.getPage': () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
      'settings.setSummaryProvider': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    await act(async () => {
      pending[0]?.(pageDto());
      await Promise.resolve();
    });
    const user = userEvent.setup();
    await user.click(await row('Codex CLI'));
    await user.click(screen.getByRole('button', { name: 'Use this engine' }));
    await user.click(screen.getByRole('button', { name: 'Claude Code CLI' }));
    await user.click(screen.getByRole('button', { name: 'Use this engine' }));
    await waitFor(() => {
      expect(pending.length).toBeGreaterThanOrEqual(3);
    });
    // The newest request answers first with the final value, the older one lands last.
    await act(async () => {
      pending.at(-1)?.(pageDto({ provider: 'ClaudeCode' }));
      await Promise.resolve();
    });
    await act(async () => {
      pending[1]?.(pageDto({ provider: 'Codex' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Claude Code CLI' })).toHaveAccessibleDescription(
      /In use/,
    );
    expect(screen.getByRole('button', { name: 'Codex CLI' })).not.toHaveAccessibleDescription(
      /In use/,
    );
  });

  it('keeps a download in progress when the page is opened again (58)', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [model('a.gguf', 'Model A', { downloading: true, percent: 37 })],
            missingActiveId: null,
          },
        }),
    });
    mount();
    const group = await openModels();
    expect(within(group).getByRole('button', { name: 'Cancel download' })).toBeInTheDocument();
    expect(within(group).getByRole('progressbar', { name: 'Downloading' })).toHaveAttribute(
      'aria-valuenow',
      '37',
    );
  });

  it('gives the Claude Code and Codex rows their brand mark', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'Codex' }) });
    mount();
    expect((await openRow('Codex CLI')).querySelector('svg')).not.toBeNull();
    expect((await row('Claude Code CLI')).querySelector('svg')).not.toBeNull();
  });

  it('keeps the reveal at 150 ms and turns motion off for reduced motion (8.5)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/index.css'), 'utf8');
    expect(css).toMatch(/--animate-fade-in:\s*fade-in 150ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation-duration: 0\.01ms/);
  });

  it('says so when the restart is refused', async () => {
    install({
      'settings.getPage': () => pageDto(),
      'settings.setUiLanguage': () => ({ status: 'saved', settings: {}, feedback: null }),
      'app.restart': () => ({ status: 'refused' }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'App language' }));
    await user.click(await screen.findByRole('option', { name: 'Español' }));
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    expect(
      await screen.findByText(
        'Vozella cannot restart while a recording is in progress. Finish it, then try again.',
      ),
    ).toBeInTheDocument();
  });

  it('says so when the restart call throws', async () => {
    install({
      'settings.getPage': () => pageDto(),
      'settings.setUiLanguage': () => ({ status: 'saved', settings: {}, feedback: null }),
      'app.restart': () => {
        throw new Error('ipc down');
      },
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'App language' }));
    await user.click(await screen.findByRole('option', { name: 'Español' }));
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    expect(await screen.findByText('Vozella could not restart. ipc down')).toBeInTheDocument();
  });

  it('stops watching the engine when the page is left (8.12)', async () => {
    install({ 'settings.getPage': () => pageDto() });
    const view = mount();
    await row('Local (on this device)');
    expect(listeners.has('transcription.statusChanged')).toBe(true);
    view.unmount();
    expect(listeners.has('transcription.statusChanged')).toBe(false);
  });

  it('keeps the kept snapshot and says so when a revisit refresh fails (8.10)', async () => {
    let n = 0;
    install({
      'settings.getPage': () => {
        n += 1;
        if (n === 1) return pageDto();
        throw new Error('disk unreadable');
      },
    });
    const first = mount();
    await row('Local (on this device)');
    first.unmount();
    mount();
    expect(
      await screen.findByText('The settings could not be loaded. disk unreadable'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Local (on this device)' }),
    ).toHaveAccessibleDescription(/In use/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says so when the read after a command fails, instead of leaving a stale control (8.10)', async () => {
    let n = 0;
    install({
      'settings.getPage': () => {
        n += 1;
        if (n >= 2) throw new Error('disk unreadable');
        return pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' });
      },
      'settings.setCliOption': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    const user = userEvent.setup();
    await screen.findByText('Detected on PATH.');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'opus' }));
    expect(
      await screen.findByText('The settings could not be loaded. disk unreadable'),
    ).toBeInTheDocument();
  });

  it('drops the kept snapshot when the data folder changes, and reads the new one (8.4)', async () => {
    let n = 0;
    install({
      'settings.getPage': () => {
        n += 1;
        return n === 1 ? pageDto({ provider: 'Codex' }) : pageDto({ provider: 'ClaudeCode' });
      },
    });
    mount();
    await inUse('Codex CLI');
    act(() => {
      emit('library.changed', { reason: 'location' });
    });
    expect(screen.queryByRole('button', { name: 'Codex CLI' })).toBeNull();
    await inUse('Claude Code CLI');
    expect(await openRow('Claude Code CLI')).toBeInTheDocument();
  });

  it('fades only on the first reveal, never on a revisit (8.5)', async () => {
    install({ 'settings.getPage': () => pageDto() });
    const first = mount();
    expect(await screen.findByTestId('settings-content')).toHaveClass('animate-fade-in');
    first.unmount();
    mount();
    expect(screen.getByTestId('settings-content')).not.toHaveClass('animate-fade-in');
  });

  it('lists Local, Claude Code, Codex and the API key engines in that order, each with its mark (28)', async () => {
    install({ 'settings.getPage': () => pageDto({ capabilities: allOn }) });
    mount();
    const rows = rowsOf(await engineList());
    expect(rows).toEqual(
      [
        'Local (on this device)',
        'Claude Code CLI',
        'Codex CLI',
        'OpenAI',
        'Anthropic',
        'Google Gemini',
        'OpenAI-compatible',
      ].map((name) => screen.getByRole('button', { name })),
    );
    for (const button of rows) expect(button.querySelector('svg')).not.toBeNull();
  });

  it('labels the providers in Spanish (28)', async () => {
    install({ 'settings.getPage': () => pageDto({ capabilities: allOn }) });
    mount('es');
    const rows = rowsOf(await engineList('Elige dónde se generan los resúmenes'));
    expect(rows).toEqual(
      [
        'Local (en este dispositivo)',
        'CLI de Claude Code',
        'CLI de Codex',
        'OpenAI',
        'Anthropic',
        'Google Gemini',
        'Compatible con OpenAI',
      ].map((name) => screen.getByRole('button', { name })),
    );
    expect(
      screen.getByRole('button', { name: 'Local (en este dispositivo)' }),
    ).toHaveAccessibleDescription('En uso');
  });

  it('shows the detection text in Spanish, and a new answer after Check again (35)', async () => {
    let detected: 'missing' | 'detected' = 'missing';
    install({
      'settings.getPage': () =>
        pageDto({
          provider: 'ClaudeCode',
          cliStatus: 'missing',
          engines: engines({ ClaudeCode: 'cli-missing' }),
        }),
      'settings.detectCli': () => ({ status: detected }),
    });
    mount('es');
    expect(
      await screen.findByText('No se encontró en el PATH: instálalo antes de grabar.'),
    ).toBeInTheDocument();
    detected = 'detected';
    await userEvent.click(screen.getByRole('button', { name: 'Comprobar de nuevo' }));
    expect(await screen.findByText('Detectado en el PATH.')).toBeInTheDocument();
    expect(screen.queryByText(/No se encontró/)).toBeNull();
  });

  it('marks the engine in use before the save and reload answer (31)', async () => {
    let releaseSave: (value: unknown) => void = () => undefined;
    install({
      'settings.getPage': () => pageDto({ provider: 'Local' }),
      'settings.setSummaryProvider': () =>
        new Promise((resolve) => {
          releaseSave = resolve;
        }),
    });
    mount();
    await inUse('Local (on this device)');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Codex CLI' }));
    await user.click(screen.getByRole('button', { name: 'Use this engine' }));
    expect(screen.getByRole('button', { name: 'Codex CLI' })).toHaveAccessibleDescription(/In use/);
    expect(
      screen.getByRole('button', { name: 'Local (on this device)' }),
    ).not.toHaveAccessibleDescription(/In use/);
    await act(async () => {
      releaseSave({ status: 'saved', settings: {}, feedback: null });
      await Promise.resolve();
    });
  });

  it('shows the card description (33, 38)', async () => {
    install({ 'settings.getPage': () => pageDto({ capabilities: allOn }) });
    mount();
    expect(
      await screen.findByText(
        'Local runs entirely on this PC for free. Claude Code and Codex use an already-installed CLI. API engines use your own key and bill your account.',
      ),
    ).toBeInTheDocument();
  });

  it('opens only the setup of the engine in use (38)', async () => {
    for (const [provider, expected] of [
      ['Local', { open: 'Local (on this device)', effort: false, local: true, status: false }],
      ['ClaudeCode', { open: 'Claude Code CLI', effort: true, local: false, status: true }],
      ['Codex', { open: 'Codex CLI', effort: true, local: false, status: true }],
      ['Xai', { open: null, effort: false, local: false, status: false }],
    ] as const) {
      resetSettingsPageCache();
      install({
        'settings.getPage': () =>
          pageDto({
            provider,
            capabilities: allOn,
            cliStatus: provider === 'ClaudeCode' || provider === 'Codex' ? 'detected' : null,
          }),
      });
      const view = mount();
      const rows = rowsOf(await engineList());
      const open = rows.filter((button) => button.getAttribute('aria-expanded') === 'true');
      expect(open).toEqual(
        expected.open ? [screen.getByRole('button', { name: expected.open })] : [],
      );
      const shown = (query: HTMLElement | null) => query !== null;
      expect(shown(screen.queryByRole('combobox', { name: 'Effort' }))).toBe(expected.effort);
      expect(shown(screen.queryByRole('button', { name: 'Change model' }))).toBe(expected.local);
      expect(shown(screen.queryByText('Detected on PATH.'))).toBe(expected.status);
      view.unmount();
    }
  });

  it('opens the Claude Code and Codex rows with their mark, model and effort (45)', async () => {
    for (const [provider, name, description] of [
      ['ClaudeCode', 'Claude Code CLI', 'Model alias and effort passed to the Claude CLI.'],
      ['Codex', 'Codex CLI', 'Model and reasoning effort passed to the Codex CLI.'],
    ] as const) {
      resetSettingsPageCache();
      install({ 'settings.getPage': () => pageDto({ provider, cliStatus: 'detected' }) });
      const view = mount();
      const button = await openRow(name);
      expect(button.querySelector('svg')).not.toBeNull();
      const panel = panelOf(button);
      expect(within(panel).getByText(description)).toBeVisible();
      expect(within(panel).getByRole('combobox', { name: 'Model' })).toBeVisible();
      expect(within(panel).getByRole('combobox', { name: 'Effort' })).toBeVisible();
      view.unmount();
    }
  });
});

describe('Summary engine list', () => {
  it('shows every engine with its status from the page, and the model of the one in use', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          provider: 'ClaudeCode',
          engines: engines({ Codex: 'cli-missing', OpenAi: 'ready' }),
          api: { ...pageDto().api, OpenAi: apiEngine({ keySet: true }) },
        }),
    });
    mount();
    const list = await engineList();
    expect(rowsOf(list)).toHaveLength(7);
    expect(
      within(list).getByRole('button', { name: 'Local (on this device)' }),
    ).toHaveAccessibleDescription('Not set up');
    expect(
      within(list).getByRole('button', { name: 'Claude Code CLI' }),
    ).toHaveAccessibleDescription('sonnet In use');
    expect(within(list).getByRole('button', { name: 'Codex CLI' })).toHaveAccessibleDescription(
      'Not found',
    );
    expect(within(list).getByRole('button', { name: 'OpenAI' })).toHaveAccessibleDescription(
      'Key saved',
    );
    expect(within(list).getByRole('button', { name: 'Anthropic' })).toHaveAccessibleDescription(
      'Needs key',
    );
    expect(
      within(list).getByRole('button', { name: 'OpenAI-compatible' }),
    ).toHaveAccessibleDescription('Not set up');
    // Each group caption names its own list of engines.
    const byCaption = (name: string) =>
      within(screen.getByRole('list', { name }))
        .getAllByRole('listitem')
        .map((item) => within(item).getAllByRole('button')[0]?.getAttribute('aria-controls'));
    expect(byCaption('On this PC')).toHaveLength(1);
    expect(byCaption('With a subscription')).toHaveLength(2);
    expect(byCaption('With your API key')).toHaveLength(4);
  });

  it('says Ready for a local model or CLI that can answer', async () => {
    install({
      'settings.getPage': () =>
        pageDto({ provider: 'OpenAi', engines: engines({ Local: 'ready', OpenAi: 'ready' }) }),
    });
    mount();
    expect(await row('Local (on this device)')).toHaveAccessibleDescription('Ready');
    expect(await row('Codex CLI')).toHaveAccessibleDescription('Ready');
    expect(await row('OpenAI')).toHaveAccessibleDescription('gpt-5-mini In use');
  });

  it('opens the engine in use on load; opening another row closes it and never switches engines', async () => {
    const calls = install({
      'settings.getPage': () => pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' }),
    });
    mount();
    const user = userEvent.setup();
    const claude = await openRow('Claude Code CLI');
    const panel = panelOf(claude);
    expect(within(panel).getByRole('combobox', { name: 'Effort' })).toBeVisible();
    expect(screen.getByText('Summaries are made with this engine.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Codex CLI' }));
    expect(screen.getByRole('button', { name: 'Codex CLI' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(claude).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('combobox', { name: 'Effort' })).toHaveLength(1);
    expect(calls.some((call) => call.name === 'settings.setSummaryProvider')).toBe(false);
    await inUse('Claude Code CLI');

    // The keyboard toggles the focused row.
    screen.getByRole('button', { name: 'Codex CLI' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Codex CLI' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Codex CLI' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers Use this engine only for a ready engine, and it switches with the saved feedback', async () => {
    let provider = 'Local';
    const calls = install({
      'settings.getPage': () =>
        pageDto({
          provider,
          engines: engines({ OpenAi: 'ready' }),
          api: { ...pageDto().api, OpenAi: apiEngine({ keySet: true }) },
        }),
      'settings.setSummaryProvider': (input) => {
        provider = (input as { kind: string }).kind;
        return {
          status: 'saved',
          settings: {},
          feedback: { key: 'Xai_FeedbackModel', args: ['gpt-5-mini'] },
        };
      },
    });
    mount();
    const user = userEvent.setup();
    await user.click(await row('Anthropic'));
    expect(screen.getByText('Save an API key to use Anthropic.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'OpenAI-compatible' }));
    expect(screen.getByText('Add the server address and a model.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(calls.some((call) => call.name === 'settings.setSummaryProvider')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Use this engine' }));
    expect(calls).toContainEqual({
      name: 'settings.setSummaryProvider',
      input: { kind: 'OpenAi' },
    });
    expect(await screen.findByText('Saved. Using gpt-5-mini.')).toBeInTheDocument();
    await inUse('OpenAI');
    // The row stays open and now says it is in use, with no second Use button.
    expect(await openRow('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Summaries are made with this engine.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();
  });

  it('says what a Local engine without a model needs', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'Codex' }) });
    mount();
    await userEvent.click(await row('Local (on this device)'));
    expect(screen.getByText('Download a model to use Local.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();
  });

  it('an engine in use that is not ready says only what it needs, and its row still says In use', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'Local' }) });
    mount();
    const local = await openRow('Local (on this device)');
    expect(within(panelOf(local)).getByText('Download a model to use Local.')).toBeVisible();
    expect(screen.queryByText('Summaries are made with this engine.')).toBeNull();
    await inUse('Local (on this device)');
  });

  it('a CLI in use that went missing says only what it needs', async () => {
    install({
      'settings.getPage': () =>
        pageDto({ provider: 'Codex', engines: engines({ Codex: 'cli-missing' }) }),
    });
    mount();
    await openRow('Codex CLI');
    expect(screen.getByText('Install Codex, then check again.')).toBeVisible();
    expect(screen.queryByText('Summaries are made with this engine.')).toBeNull();
    await inUse('Codex CLI');
  });

  it('Check again detects the CLI of the open row, not the engine in use', async () => {
    let codex: 'missing' | 'detected' = 'missing';
    const calls = install({
      'settings.getPage': () => pageDto({ engines: engines({ Codex: 'cli-missing' }) }),
      'settings.detectCli': () => ({ status: codex }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await row('Codex CLI'));
    expect(screen.getByText('Not found on PATH — install it before recording.')).toBeVisible();
    expect(screen.getByText('Install Codex, then check again.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this engine' })).toBeNull();

    codex = 'detected';
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(calls).toContainEqual({ name: 'settings.detectCli', input: { kind: 'Codex' } });
    expect(await screen.findByText('Detected on PATH.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Codex CLI' })).toHaveAccessibleDescription('Ready');
    expect(screen.getByRole('button', { name: 'Use this engine' })).toBeVisible();
    // The engine in use is still Local.
    await inUse('Local (on this device)');
  });

  it('drops the effort help text from the CLI setup', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'ClaudeCode' }) });
    mount();
    await openRow('Claude Code CLI');
    expect(screen.getByRole('combobox', { name: 'Effort' })).toBeVisible();
    expect(screen.queryByText('low, medium, high, xhigh, or max.')).toBeNull();
  });
});

describe('Local engine setup', () => {
  it('shows the active model on one line and keeps the model list in a dialog', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          engines: engines({ Local: 'ready' }),
          models: {
            rows: [
              model('a.gguf', 'Model A'),
              model('b.gguf', 'Model B', { downloaded: true, active: true, vendor: 'IBM' }),
            ],
            missingActiveId: null,
          },
        }),
    });
    mount();
    const panel = panelOf(await openRow('Local (on this device)'));
    expect(within(panel).getByText('Model B')).toBeVisible();
    expect(
      within(panel).getByText('Fast · Quality Very good · 3.1 GB download', { exact: false }),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: 'Summary models' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();

    const group = await openModels();
    expect(within(group).getByRole('radio', { name: /Model B/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /Model A/ })).toBeInTheDocument();
    await userEvent.click(within(modelsDialog()).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Summary models' })).toBeNull();
    });
  });

  it('without an active model offers Set up, Change model, and names a missing model', async () => {
    install({
      'settings.getPage': () =>
        pageDto({
          models: {
            rows: [model('b.gguf', 'Model B', { downloaded: true })],
            missingActiveId: 'gone.gguf',
          },
        }),
    });
    mount();
    const panel = panelOf(await openRow('Local (on this device)'));
    expect(within(panel).getByRole('button', { name: 'Set up' })).toHaveClass('bg-ink');
    expect(within(panel).getByRole('button', { name: 'Change model' })).not.toHaveClass('bg-ink');
    expect(within(panel).getByText(/gone\.gguf/)).toBeVisible();
    const group = await openModels();
    expect(within(group).getByRole('radio', { name: /Model B/ })).not.toBeChecked();
  });

  it('downloads a model from the dialog and shows its progress there', async () => {
    const calls = install({
      'settings.getPage': () => pageDto(),
      'settings.models.download': () => new Promise(() => undefined),
    });
    mount();
    const group = await openModels();
    await userEvent.click(within(group).getByRole('button', { name: 'Download' }));
    expect(calls).toContainEqual({
      name: 'settings.models.download',
      input: { fileName: 'a.gguf' },
    });
    act(() => {
      listeners.get('settings.modelEvent')?.({ type: 'progress', fileName: 'a.gguf', percent: 12 });
    });
    expect(
      await within(modelsDialog()).findByRole('progressbar', { name: 'Downloading' }),
    ).toHaveAttribute('aria-valuenow', '12');
  });
});

describe('Settings page (saved bar)', () => {
  it('closes the saved bar when the user presses Close (76)', async () => {
    install({
      'settings.getPage': () => pageDto({ provider: 'ClaudeCode', cliStatus: 'detected' }),
      'settings.setCliOption': () => ({
        status: 'saved',
        settings: {},
        feedback: { key: 'Xai_FeedbackModel', args: ['opus'] },
      }),
    });
    mount();
    const user = userEvent.setup();
    await screen.findByText('Detected on PATH.');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'opus' }));
    expect(await screen.findByText('Saved. Using opus.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Saved. Using opus.')).toBeNull();
  });
});
