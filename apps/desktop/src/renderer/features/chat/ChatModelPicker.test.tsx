// @vitest-environment jsdom
import type {
  ChatEngineChoicesDto,
  ChatPromptDto,
  ChatSendOutcomeDto,
  ChatStateDto,
} from '@vozella/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { DialogHost } from '../../app/dialog-service';
import { takeEngineFocus } from '../settings/engine-focus';
import { ChatBody } from './ChatBody';

// C2: the model picker beside Send. The choice lives for the conversation and never writes Settings.

vi.mock('../ai-provider/ProviderGateDialogs', () => ({ ProviderGateDialogs: () => null }));

beforeAll(() => {
  // jsdom has no layout, so it has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

type Listener = (payload: unknown) => void;

const ALL = { isVisible: true, kind: 'AllMeetings', folderId: null, meetingId: null } as const;

const CHOICES: ChatEngineChoicesDto = {
  defaultEngine: 'claude-code',
  engines: [
    {
      engine: 'local',
      readiness: 'needs-model',
      models: [],
      effortOptions: [],
      defaultModel: null,
      defaultEffort: null,
    },
    {
      engine: 'claude-code',
      readiness: 'ready',
      models: [
        { id: 'sonnet', label: 'sonnet' },
        { id: 'opus', label: 'opus' },
      ],
      effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultModel: 'sonnet',
      defaultEffort: 'low',
    },
    {
      engine: 'codex',
      readiness: 'cli-missing',
      models: [{ id: 'gpt-5.6', label: 'gpt-5.6' }],
      effortOptions: ['low', 'medium'],
      defaultModel: 'gpt-5.6',
      defaultEffort: 'low',
    },
    {
      engine: 'openai',
      readiness: 'ready',
      models: [
        { id: 'gpt-5-mini', label: 'GPT-5 mini' },
        { id: 'gpt-4o', label: 'GPT-4o' },
      ],
      effortOptions: [],
      defaultModel: 'gpt-5-mini',
      defaultEffort: null,
    },
    {
      engine: 'anthropic',
      readiness: 'needs-key',
      models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
      effortOptions: [],
      defaultModel: 'claude-sonnet-5-5',
      defaultEffort: null,
    },
  ],
};

const stateOf = (over: Partial<ChatStateDto> = {}): ChatStateDto => ({
  messages: [],
  isSending: false,
  showScopeMismatch: false,
  hasMessages: false,
  canStartNewChat: true,
  attachments: [],
  ...over,
});

const msg = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  text,
  createdAt: '2026-09-01T09:00:00Z',
});

function install(
  options: {
    choices?: () => ChatEngineChoicesDto;
    prompts?: ChatPromptDto[];
    send?: (n: number) => ChatSendOutcomeDto | undefined;
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  const inputs: { name: string; input: Record<string, unknown> }[] = [];
  const invoke = vi.fn(async (name: string, input: Record<string, unknown>) => {
    await Promise.resolve();
    inputs.push({ name, input });
    switch (name) {
      case 'chat.state':
        return stateOf();
      case 'chat.getEngineChoices':
        return (options.choices ?? (() => CHOICES))();
      case 'chat.prompts.list':
        return { prompts: options.prompts ?? [] };
      case 'workspace.getState':
        return { liveTranscript: '' };
      case 'workspace.dispatch':
        return {};
      case 'chat.send': {
        const n = inputs.filter((entry) => entry.name === 'chat.send').length;
        return (
          options.send?.(n) ??
          ({
            status: 'answered',
            user: msg(`u${String(n)}`, 'user', input.draft as string),
            assistant: msg(`a${String(n)}`, 'assistant', 'Done.'),
            notice: null,
          } satisfies ChatSendOutcomeDto)
        );
      }
      default:
        throw new Error(`unhandled ${name}`);
    }
  });
  Object.defineProperty(window, 'vozella', {
    value: {
      invoke,
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(name, set);
        return () => set.delete(listener);
      },
    },
    configurable: true,
    writable: true,
  });
  const calls = (name: string) => inputs.filter((i) => i.name === name).map((i) => i.input);
  return { calls };
}

afterEach(() => {
  cleanup();
  takeEngineFocus();
  Reflect.deleteProperty(window, 'vozella');
});

const body = (epoch = 0) => (
  <Providers>
    <DialogHost>
      <ChatBody key={epoch} scope={ALL} />
    </DialogHost>
  </Providers>
);

const box = () => screen.getByTestId<HTMLTextAreaElement>('TxtMeetingChat');
const chip = () => screen.findByRole('button', { name: /^Model: / });
const popup = () => screen.findByRole('dialog', { name: 'Models' });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await chip());
  return popup();
}

async function sendText(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(box());
  await user.type(box(), `${text}{Enter}`);
}

describe('model picker chip', () => {
  it('names the Settings engine, model and effort, and opens a dialog', async () => {
    install();
    render(body());
    const button = await chip();
    expect(button).toHaveAccessibleName('Model: Claude Code, Sonnet · Low');
    expect(button).toHaveTextContent('Sonnet · Low');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('is hidden when the choices cannot be read, and the chat still sends with Settings', async () => {
    const api = install({
      choices: () => {
        throw new Error('no ipc');
      },
    });
    const user = userEvent.setup();
    render(body());
    await waitFor(() => {
      expect(api.calls('chat.getEngineChoices')).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: /^Model/ })).toBeNull();
    await sendText(user, 'Hello');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    expect(api.calls('chat.send')[0]).not.toHaveProperty('engine');
  });

  it('sits on the toolbar line under the message box, before Send', async () => {
    install();
    render(body());
    const button = await chip();
    const order = Array.from(
      document.querySelectorAll(
        '[data-testid="TxtMeetingChat"], [data-testid="BtnChatModel"], [data-testid="BtnMeetingChatSend"], [data-testid="BtnMeetingChatRecipes"]',
      ),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'TxtMeetingChat',
      'BtnMeetingChatRecipes',
      'BtnChatModel',
      'BtnMeetingChatSend',
    ]);
    expect(button).toHaveAttribute('data-testid', 'BtnChatModel');
  });
});

describe('model picker popup', () => {
  it('groups engines by what the user brings, with a search field first and a footer note', async () => {
    install();
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    const search = within(dialog).getByRole('combobox', { name: 'Search models' });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    const list = within(dialog).getByRole('listbox', { name: 'Models' });
    expect(
      within(list)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label') ?? g.textContent),
    ).toHaveLength(3);
    expect(within(list).getByRole('group', { name: 'On this PC' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'With a subscription' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'With your API key' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'Sonnet' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(list).getByRole('option', { name: 'Opus' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(dialog).toHaveTextContent('Applies to this chat. Summaries use the engine in Settings.');
  });

  it('shows an engine that is not ready as one dimmed row whose action opens it in Settings', async () => {
    const api = install();
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    const codex = within(dialog).getByRole('option', { name: 'Codex' });
    expect(codex).toHaveAccessibleDescription('Not found Install');
    expect(within(dialog).queryByRole('option', { name: 'GPT-5.6' })).toBeNull();
    const local = within(dialog).getByRole('option', { name: 'Local' });
    expect(local).toHaveAccessibleDescription('Not set up Download a model');
    expect(within(dialog).getByRole('option', { name: 'Anthropic' })).toHaveAccessibleDescription(
      'Needs key Add key',
    );
    await user.click(codex);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Models' })).toBeNull();
    });
    expect(api.calls('workspace.dispatch')).toContainEqual({
      action: { type: 'navigateTo', tag: 'Settings' },
    });
    expect(takeEngineFocus()).toBe('Codex');
  });

  it('lists downloaded local models and a row for the rest in Settings', async () => {
    install({
      choices: () => ({
        ...CHOICES,
        engines: CHOICES.engines.map((entry) =>
          entry.engine === 'local'
            ? {
                ...entry,
                models: [{ id: 'gemma.gguf', label: 'Gemma 3 4B' }],
                defaultModel: 'gemma.gguf',
              }
            : entry,
        ),
      }),
    });
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    expect(within(dialog).getByRole('option', { name: 'Gemma 3 4B' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('option', { name: 'More models in Settings' }));
    expect(takeEngineFocus()).toBe('Local');
  });

  it('filters by engine or model name; arrows, End and Enter pick from the search field', async () => {
    const api = install();
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    await user.keyboard('opu');
    const list = within(dialog).getByRole('listbox', { name: 'Models' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Opus']);
    await user.clear(within(dialog).getByRole('combobox', { name: 'Search models' }));
    await user.keyboard('xyz');
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
    expect(dialog).toHaveTextContent('No engine or model matches.');
    await user.clear(within(dialog).getByRole('combobox', { name: 'Search models' }));
    await user.keyboard('openai');
    await user.keyboard('{End}{Enter}');
    expect(await chip()).toHaveAccessibleName('Model: OpenAI, GPT-4o');
    await user.keyboard('{Escape}');
    await sendText(user, 'Hello');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    expect(api.calls('chat.send')[0]).toMatchObject({ engine: 'openai', model: 'gpt-4o' });
    expect(api.calls('chat.send')[0]).not.toHaveProperty('effort');
  });

  it('Escape closes it and gives focus back to the chip', async () => {
    install();
    const user = userEvent.setup();
    render(body());
    await openPicker(user);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Models' })).toBeNull();
    });
    expect(await chip()).toHaveFocus();
  });
});

describe('model picker effort', () => {
  it('a stepped bar names the level, and arrows move it', async () => {
    const api = install();
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    const effort = within(dialog).getByRole('radiogroup', { name: 'Effort' });
    const steps = within(effort).getAllByRole('radio');
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    expect(within(effort).getByRole('radio', { name: 'Low' })).toBeChecked();
    within(effort).getByRole('radio', { name: 'Low' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(within(effort).getByRole('radio', { name: 'Medium' })).toBeChecked();
    expect(await chip()).toHaveAccessibleName('Model: Claude Code, Sonnet · Medium');
    await user.keyboard('{Escape}');
    await sendText(user, 'Hello');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    expect(api.calls('chat.send')[0]).toMatchObject({
      engine: 'claude-code',
      model: 'sonnet',
      effort: 'medium',
    });
  });

  it('has no bar for an engine without effort, and picking another engine resets the effort', async () => {
    install();
    const user = userEvent.setup();
    render(body());
    let dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('radio', { name: 'High' }));
    await user.click(within(dialog).getByRole('option', { name: 'GPT-4o' }));
    expect(within(dialog).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    await user.click(within(dialog).getByRole('option', { name: 'Opus' }));
    expect(within(dialog).getByRole('radio', { name: 'Low' })).toBeChecked();
    await user.keyboard('{Escape}');
    dialog = await openPicker(user);
    expect(within(dialog).getByRole('option', { name: 'Opus' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('model picker and sending', () => {
  it('a send with the default choice carries no engine, model or effort', async () => {
    const api = install();
    const user = userEvent.setup();
    render(body());
    await chip();
    await sendText(user, 'Hello');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    const sent = api.calls('chat.send')[0];
    expect(sent).not.toHaveProperty('engine');
    expect(sent).not.toHaveProperty('model');
    expect(sent).not.toHaveProperty('effort');
  });

  it('a picked model answers every send of the conversation', async () => {
    const api = install();
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('option', { name: 'Opus' }));
    await user.keyboard('{Escape}');
    await sendText(user, 'One');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    await sendText(user, 'Two');
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(2);
    });
    for (const sent of api.calls('chat.send')) {
      expect(sent).toMatchObject({ engine: 'claude-code', model: 'opus', effort: 'low' });
    }
    expect(api.calls('settings.update')).toHaveLength(0);
  });

  it('a saved prompt with its own engine still answers with that engine', async () => {
    const api = install({
      prompts: [
        {
          id: 'p1',
          name: 'Risk review',
          prompt: 'List the risks.',
          availability: 'multiple',
          engine: 'codex',
        },
      ],
    });
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('option', { name: 'Opus' }));
    await user.keyboard('{Escape}');
    const chips = await screen.findByTestId('ListMeetingChatStarters');
    await waitFor(() => {
      expect(within(chips).getAllByTestId('BtnChatStarter')[0]).toHaveTextContent('Risk review');
    });
    const [first] = within(chips).getAllByTestId('BtnChatStarter');
    if (!first) throw new Error('no starter');
    await user.click(first);
    await waitFor(() => {
      expect(api.calls('chat.send')).toHaveLength(1);
    });
    const sent = api.calls('chat.send')[0];
    expect(sent).toMatchObject({ engine: 'codex' });
    expect(sent).not.toHaveProperty('model');
    expect(sent).not.toHaveProperty('effort');
  });

  it('a picked engine that stopped being ready goes back to Settings without the setup gate', async () => {
    let ready = true;
    const api = install({
      choices: () =>
        ready
          ? CHOICES
          : {
              ...CHOICES,
              engines: CHOICES.engines.map((entry) =>
                entry.engine === 'openai' ? { ...entry, readiness: 'needs-key' as const } : entry,
              ),
            },
      send: (n) =>
        n === 1 ? { status: 'setup-required', kind: 'OpenAi', originalDraft: 'Hello' } : undefined,
    });
    const user = userEvent.setup();
    render(body());
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('option', { name: 'GPT-4o' }));
    await user.keyboard('{Escape}');
    ready = false;
    await sendText(user, 'Hello');
    expect(
      await screen.findByText(
        'OpenAI is not ready anymore. This chat is back on the engine in Settings.',
      ),
    ).toBeInTheDocument();
    expect(box()).toHaveValue('Hello');
    expect(await chip()).toHaveAccessibleName('Model: Claude Code, Sonnet · Low');
    expect(api.calls('chat.send')).toHaveLength(1);
  });

  it('New chat starts again from the Settings choice', async () => {
    install();
    const user = userEvent.setup();
    const view = render(body(0));
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('option', { name: 'Opus' }));
    await user.keyboard('{Escape}');
    expect(await chip()).toHaveAccessibleName('Model: Claude Code, Opus · Low');
    view.rerender(body(1));
    await waitFor(async () => {
      expect(await chip()).toHaveAccessibleName('Model: Claude Code, Sonnet · Low');
    });
  });
});
