// @vitest-environment jsdom
import type { SettingsPageDto } from '@vozella/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../app/theme';
import { Providers } from '../../app/test-providers';
import { SettingsRoute } from './SettingsRoute';
import { resetSettingsPageCache } from './use-settings-page';

const SECRET = 'sk-test-SECRET-123';

const engine = (extra: Record<string, unknown> = {}) => ({
  keySet: false,
  model: 'gpt-5-mini',
  modelOptions: ['gpt-5-mini', 'gpt-5'],
  modelLabels: { 'gpt-5-mini': 'GPT-5 Mini' },
  baseUrl: null,
  ...extra,
});

function pageDto(extra: Record<string, unknown> = {}): SettingsPageDto {
  return {
    settings: {},
    uiLanguage: 'en-US',
    provider: 'OpenAi',
    claude: { model: 'sonnet', effort: 'low', modelOptions: ['sonnet'], effortOptions: ['low'] },
    codex: { model: 'gpt-5.6', effort: 'low', modelOptions: ['gpt-5.6'], effortOptions: ['low'] },
    api: {
      OpenAi: engine(),
      Anthropic: engine({ model: 'claude-sonnet-5-5', modelOptions: ['claude-sonnet-5-5'] }),
      Gemini: engine({ model: 'gemini-2.5-flash', modelOptions: ['gemini-2.5-flash'] }),
      OpenAiCompatible: engine({ model: '', modelOptions: [] }),
    },
    cliStatus: null,
    engines: [],
    transcriptionLanguage: 'es',
    summaryLanguage: 'es',
    hardware: null,
    models: { rows: [], missingActiveId: null },
    providerNotice: null,
    capabilities: { localModels: true },
    notices: [],
    ...extra,
  } as unknown as SettingsPageDto;
}

type Handler = (input: unknown) => unknown;

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
    on: () => () => undefined,
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

const keyField = () => screen.getByLabelText('API key', { selector: 'input' });

beforeEach(() => {
  resetSettingsPageCache();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

describe('Settings: API key engines (BYOK)', () => {
  it('offers the four API engines in the one provider group, captioned by what the user brings', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'Local' }) });
    mount();
    const group = await screen.findByRole('radiogroup', {
      name: 'Choose where summaries are generated',
    });
    const radios = within(group).getAllByRole('radio');
    const expected = [
      'Local (on this device)',
      'Claude Code CLI',
      'Codex CLI',
      'OpenAI',
      'Anthropic',
      'Google Gemini',
      'OpenAI-compatible',
    ];
    expect(radios).toHaveLength(expected.length);
    radios.forEach((radio, index) => {
      expect(radio).toHaveAccessibleName(expected[index]);
    });
    expect(within(group).getByRole('radio', { name: 'OpenAI' })).toHaveAccessibleDescription(
      'With your API key',
    );
    expect(screen.queryByTestId('ApiProviderOptions')).toBeNull();
  });

  it('selecting an API engine saves its kind and shows its key, model and privacy notice', async () => {
    let provider = 'Local';
    const calls = install({
      'settings.getPage': () => pageDto({ provider }),
      'settings.setSummaryProvider': (input) => {
        provider = (input as { kind: string }).kind;
        return { status: 'saved', settings: {}, feedback: null };
      },
    });
    mount();
    await userEvent.click(await screen.findByRole('radio', { name: 'Anthropic' }));
    expect(calls).toContainEqual({
      name: 'settings.setSummaryProvider',
      input: { kind: 'Anthropic' },
    });
    expect(
      await screen.findByText(
        'Transcripts and chat messages are sent to Anthropic to get an answer. Usage is billed to your Anthropic account.',
      ),
    ).toBeVisible();
    expect(keyField()).toHaveAttribute('type', 'password');
    expect(keyField()).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Model', { selector: 'input' })).toHaveValue('claude-sonnet-5-5');
    expect(screen.queryByLabelText('Server address', { selector: 'input' })).toBeNull();
  });

  it('saves a key once, never shows it again, and shows the saved mask', async () => {
    let keySet = false;
    const calls = install({
      'settings.getPage': () => pageDto({ api: { ...pageDto().api, OpenAi: engine({ keySet }) } }),
      'settings.setApiKey': () => {
        keySet = true;
        return { status: 'saved', keySet: true };
      },
    });
    mount();
    const user = userEvent.setup();
    await screen.findByTestId('ApiProviderOptions');
    expect(screen.getByText('No key saved yet. It is stored encrypted on this PC.')).toBeVisible();
    await user.type(keyField(), SECRET);
    await user.click(screen.getByRole('button', { name: 'Show key' }));
    expect(keyField()).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(calls).toContainEqual({
      name: 'settings.setApiKey',
      input: { kind: 'OpenAi', key: SECRET },
    });
    expect(await screen.findByTestId('TxtApiKeyStatus')).toHaveTextContent('Key saved.');
    expect(
      await screen.findByText('Key saved. It is encrypted on this PC and never shown again.'),
    ).toBeVisible();
    expect(keyField()).toHaveValue('');
    expect(keyField()).toHaveAttribute('type', 'password');
    expect(keyField().getAttribute('placeholder')).toMatch(/^•+$/);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('removes a saved key', async () => {
    let keySet = true;
    const calls = install({
      'settings.getPage': () => pageDto({ api: { ...pageDto().api, OpenAi: engine({ keySet }) } }),
      'settings.clearApiKey': () => {
        keySet = false;
        return { status: 'saved', keySet: false };
      },
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    expect(calls).toContainEqual({ name: 'settings.clearApiKey', input: { kind: 'OpenAi' } });
    expect(await screen.findByTestId('TxtApiKeyStatus')).toHaveTextContent('Key removed.');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
    });
  });

  it('Verify adds the models the key can use to the suggestions, and a typed model saves', async () => {
    const calls = install({
      'settings.getPage': () =>
        pageDto({ api: { ...pageDto().api, OpenAi: engine({ keySet: true }) } }),
      'settings.verifyApiKey': () => ({ status: 'verified', models: ['gpt-5', 'o9-preview'] }),
      'settings.setApiOption': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByTestId('TxtApiKeyStatus')).toHaveTextContent(
      'Verified. 2 models are listed under Model.',
    );
    const field = screen.getByRole('combobox', { name: 'Model' });
    await user.click(field);
    const options = within(await screen.findByTestId('ListApiModels'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['gpt-5', 'o9-preview', 'GPT-5 Minigpt-5-mini']);
    await user.keyboard('{Escape}');

    await user.clear(field);
    await user.type(field, 'o9-preview{Enter}');
    expect(calls).toContainEqual({
      name: 'settings.setApiOption',
      input: { kind: 'OpenAi', field: 'model', value: 'o9-preview' },
    });
  });

  it('the model picker lists every suggestion even though a model is saved, and a pick saves', async () => {
    const calls = install({
      'settings.getPage': () =>
        pageDto({
          provider: 'Anthropic',
          api: {
            ...pageDto().api,
            Anthropic: engine({
              model: 'claude-opus-5-5',
              modelOptions: ['claude-opus-5-5', 'claude-sonnet-5-5'],
              modelLabels: {
                'claude-opus-5-5': 'Claude Opus 5.5',
                'claude-sonnet-5-5': 'Claude Sonnet 5.5',
              },
            }),
          },
        }),
      'settings.setApiOption': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    const user = userEvent.setup();
    const field = await screen.findByRole('combobox', { name: 'Model' });
    expect(field).toHaveValue('claude-opus-5-5');
    expect(field).toHaveAccessibleDescription(
      'Pick a suggestion or type any model id. Verify lists the models your key can use.',
    );
    await user.click(field);
    expect(await screen.findAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: /Claude Sonnet 5\.5/ }));
    expect(calls).toContainEqual({
      name: 'settings.setApiOption',
      input: { kind: 'Anthropic', field: 'model', value: 'claude-sonnet-5-5' },
    });
    expect(calls.filter((call) => call.name === 'settings.setApiOption')).toHaveLength(1);
  });

  it('a model id with spaces is refused inline, and a blank one quietly goes back', async () => {
    const calls = install({
      'settings.getPage': () => pageDto(),
      'settings.setApiOption': () => ({ status: 'saved', settings: {}, feedback: null }),
    });
    mount();
    const user = userEvent.setup();
    const field = await screen.findByRole('combobox', { name: 'Model' });
    await user.clear(field);
    await user.type(field, 'gpt 5{Enter}');
    expect(await screen.findByText('A model id has no spaces.')).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field);
    await user.click(keyField());
    expect(field).toHaveValue('gpt-5-mini');
    expect(screen.queryByText('A model id has no spaces.')).toBeNull();
    expect(calls.filter((call) => call.name === 'settings.setApiOption')).toHaveLength(0);
  });

  it('a refused key is explained inline, in the live region', async () => {
    install({
      'settings.getPage': () =>
        pageDto({ api: { ...pageDto().api, OpenAi: engine({ keySet: true }) } }),
      'settings.verifyApiKey': () => ({ status: 'failed', errorKey: 'Ui_ApiKeyInvalid' }),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    const status = await screen.findByTestId('TxtApiKeyStatus');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('OpenAI did not accept your API key. Check it in Settings.');
  });

  it('only the compatible engine asks for a server address, and an invalid one is explained', async () => {
    const calls = install({
      'settings.getPage': () => pageDto({ provider: 'OpenAiCompatible' }),
      'settings.setApiOption': () => ({ status: 'ignored', reason: 'invalid' }),
    });
    mount();
    const user = userEvent.setup();
    const address = await screen.findByLabelText('Server address', { selector: 'input' });
    expect(screen.getByText(/OpenRouter, Groq, Ollama, LM Studio/)).toBeVisible();
    expect(
      screen.getByText('Optional. Local servers such as Ollama or LM Studio usually need none.'),
    ).toBeVisible();
    await user.type(address, 'ftp://example{Enter}');
    expect(calls).toContainEqual({
      name: 'settings.setApiOption',
      input: { kind: 'OpenAiCompatible', field: 'baseUrl', value: 'ftp://example' },
    });
    expect(
      await screen.findByText('Enter an address that starts with http:// or https://.'),
    ).toBeVisible();
    expect(address).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the API block in Spanish', async () => {
    install({ 'settings.getPage': () => pageDto({ provider: 'Gemini' }) });
    mount('es');
    expect(await screen.findByLabelText('Clave de API', { selector: 'input' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Google Gemini' })).toHaveAccessibleDescription(
      'Con tu clave de API',
    );
  });
});
