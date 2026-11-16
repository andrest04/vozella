// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Providers } from '../../app/test-providers';
import { TranscriptionSection } from './TranscriptionSection';
import { openTranscriptionInSettings } from './transcription-focus';
import { baseStatus, installTranscriptionApi, sectionProps } from './transcription-test-kit';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

/** The local engine is on this PC; a cloud engine is selected and has no key. */
const groqNoKey = {
  ...baseStatus,
  engine: 'Groq',
  ready: false,
  cloudNotReadyReason: 'key-missing',
};
const groqReady = { ...baseStatus, engine: 'Groq', ready: true };

const mount = (props = sectionProps(), locale: 'en' | 'es' = 'en') => {
  render(
    <Providers locale={locale}>
      <TranscriptionSection {...props} />
    </Providers>,
  );
  return props;
};

const choice = () => screen.findByRole('radiogroup', { name: 'Where meetings are transcribed' });
const updates = (api: ReturnType<typeof installTranscriptionApi>) =>
  api.calls.filter((call) => call.name === 'settings.update').map((call) => call.input);

describe('TranscriptionSection: the engine choice', () => {
  it('offers this PC and each cloud engine as one radio group, with this PC chosen by default', async () => {
    installTranscriptionApi();
    mount();
    const group = await choice();
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(within(group).getByRole('radio', { name: /^On this PC/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /^Groq/ })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: /^OpenAI/ })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: /^Deepgram/ })).not.toBeChecked();
    // Nothing about a cloud engine is shown while this PC transcribes.
    expect(screen.queryByTestId('cloud-engine-setup')).toBeNull();
    expect(screen.queryByText(/is sent to/)).toBeNull();
  });

  it('says whether each cloud engine has its key, in words', async () => {
    installTranscriptionApi();
    mount(sectionProps({ keys: ['OpenAi'] }));
    const group = await choice();
    // In the radio's own name for a screen reader, and as visible words beside it.
    expect(within(group).getByRole('radio', { name: /^Groq.*Needs key/ })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /^OpenAI.*Key saved/ })).toBeInTheDocument();
    expect(within(group).getByTestId('engine-key-Groq')).toHaveTextContent('Needs key');
    expect(within(group).getByTestId('engine-key-OpenAi')).toHaveTextContent('Key saved');
    expect(within(group).queryByTestId('engine-key-Local')).toBeNull();
  });

  it('offers Deepgram last, with its own key and the promise of text as you speak', async () => {
    installTranscriptionApi();
    mount(sectionProps({ keys: ['Deepgram'] }));
    const group = await choice();
    const deepgram = within(group).getByRole('radio', { name: /^Deepgram.*Key saved/ });
    expect(within(group).getAllByRole('radio').at(-1)).toBe(deepgram);
    expect(
      within(group).getByText(
        'In the cloud, with your own Deepgram API key. The text appears as you speak.',
      ),
    ).toBeVisible();
    expect(within(group).getByTestId('engine-key-Deepgram')).toHaveTextContent('Key saved');
    // The key of Groq is another key: saving Deepgram's says nothing about it.
    expect(within(group).getByTestId('engine-key-Groq')).toHaveTextContent('Needs key');
    // The engines that upload pieces keep their own words.
    expect(
      within(group).getByText('In the cloud, with your own Groq API key. Works on any computer.'),
    ).toBeVisible();
    expect(
      within(group).queryByText(
        'In the cloud, with your own Groq API key. The text appears as you speak.',
      ),
    ).toBeNull();
  });

  it('choosing Deepgram saves it and drops a model that is not its own', async () => {
    const api = installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'], cloudModel: 'whisper-large-v3' }));
    await userEvent.click(within(await choice()).getByRole('radio', { name: /^Deepgram/ }));
    await waitFor(() => {
      expect(updates(api)).toEqual([
        { patch: { transcriptionEngine: 'Deepgram', cloudTranscriptionModelId: null } },
      ]);
    });
  });

  it('choosing a cloud engine saves it and asks for the status again', async () => {
    let status: Record<string, unknown> = baseStatus;
    const api = installTranscriptionApi({
      'transcription.getStatus': () => status,
      'settings.update': () => {
        status = groqNoKey;
        return {};
      },
    });
    mount();
    await userEvent.click(within(await choice()).getByRole('radio', { name: /^Groq/ }));
    expect(await screen.findByTestId('cloud-engine-setup')).toBeVisible();
    expect(updates(api)).toEqual([{ patch: { transcriptionEngine: 'Groq' } }]);
    expect(within(await choice()).getByRole('radio', { name: /^Groq/ })).toBeChecked();
  });

  it('going back to this PC clears the setting and keeps the saved cloud model', async () => {
    const api = installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'], cloudModel: 'whisper-large-v3' }));
    await userEvent.click(within(await choice()).getByRole('radio', { name: /^On this PC/ }));
    await waitFor(() => {
      expect(updates(api)).toEqual([{ patch: { transcriptionEngine: null } }]);
    });
  });

  it('switching provider keeps a model the new provider lists and drops one it does not', async () => {
    const api = installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'], cloudModel: 'whisper-large-v3' }));
    await userEvent.click(within(await choice()).getByRole('radio', { name: /^OpenAI/ }));
    await waitFor(() => {
      expect(updates(api)).toEqual([
        { patch: { transcriptionEngine: 'OpenAi', cloudTranscriptionModelId: null } },
      ]);
    });
    cleanup();

    const again = installTranscriptionApi();
    mount(sectionProps({ cloudModel: 'whisper-large-v3' }));
    await userEvent.click(within(await choice()).getByRole('radio', { name: /^Groq/ }));
    await waitFor(() => {
      expect(updates(again)).toEqual([{ patch: { transcriptionEngine: 'Groq' } }]);
    });
  });

  it('follows a status push from main, as when another window changed the engine', async () => {
    const api = installTranscriptionApi();
    mount();
    expect(within(await choice()).getByRole('radio', { name: /^On this PC/ })).toBeChecked();
    api.emit('transcription.statusChanged', groqNoKey);
    expect(await screen.findByTestId('cloud-engine-setup')).toBeVisible();
    expect(within(await choice()).getByRole('radio', { name: /^Groq/ })).toBeChecked();
  });
});

describe('TranscriptionSection: a cloud engine without its key', () => {
  it('names the provider the audio goes to, where the choice is made', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    mount();
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    const notice = within(setup).getByText(
      'While Groq is selected, the audio of each meeting is sent to Groq to be turned into text.',
    );
    // A notice with a glyph and words, not a color.
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it('shows the key field and Verify of the API engines, and saves the key for that provider', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    const props = mount();
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    const key = within(setup).getByLabelText('API key', { selector: 'input' });
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveAccessibleDescription('No key saved yet. It is stored encrypted on this PC.');
    expect(within(setup).getByRole('button', { name: 'Verify' })).toBeEnabled();
    await userEvent.type(key, 'gsk-test-123');
    await userEvent.click(within(setup).getByRole('button', { name: 'Save key' }));
    expect(props.model.calls).toEqual([{ name: 'setApiKey', kind: 'Groq', key: 'gsk-test-123' }]);
    expect(await within(setup).findByText('Key saved.')).toBeVisible();
    expect(key).toHaveValue('');
  });

  it('opens the guide with numbered steps and the link to the provider key page', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    mount();
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    const toggle = within(setup).getByRole('button', { name: 'How to get a Groq API key' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = within(within(setup).getByRole('list')).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Open the Groq API keys page (opens in your browser)',
      'Sign in, or create an account if you do not have one.',
      'Create a new key and copy it.',
      'Paste it in the API key box and select Save key.',
    ]);
    const link = within(setup).getByRole('link', { name: /Open the Groq API keys page/ });
    expect(link).toHaveAttribute('href', 'https://console.groq.com/keys');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(
      within(setup).getByText(
        'Groq bills your own account for the audio it transcribes. Check the current prices on its site before you start.',
      ),
    ).toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(setup).queryByRole('list')).toBeNull();
  });

  it('links the OpenAI key page for OpenAI', async () => {
    installTranscriptionApi({
      'transcription.getStatus': () => ({ ...groqNoKey, engine: 'OpenAi' }),
    });
    mount();
    const setup = await screen.findByRole('group', { name: 'OpenAI setup' });
    expect(
      within(setup).getByRole('link', { name: /Open the OpenAI API keys page/ }),
    ).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  });

  it('keeps live captions off with the reason, and never offers the local download as the fix', async () => {
    installTranscriptionApi({
      'transcription.getStatus': () => ({ ...groqNoKey, liveEnabled: true }),
    });
    mount();
    const live = await screen.findByRole('switch', { name: 'Live transcription during recording' });
    await waitFor(() => {
      expect(live).toHaveAttribute('aria-disabled', 'true');
    });
    expect(live).not.toBeChecked();
    expect(
      screen.getByRole('group', { name: 'Live transcription during recording' }),
    ).toHaveAccessibleDescription('Add your Groq API key to use this.');
    expect(screen.queryByText('Download the transcription engine to use this.')).toBeNull();
  });
});

describe('TranscriptionSection: a cloud engine with its key', () => {
  it('says the key is saved, folds the guide, and says the key also serves summaries', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'] }));
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    expect(
      within(setup).getByLabelText('API key', { selector: 'input' }),
    ).toHaveAccessibleDescription('Key saved. It is encrypted on this PC and never shown again.');
    expect(within(setup).getByRole('button', { name: 'Remove key' })).toBeEnabled();
    expect(
      within(setup).getByText('The same key also works for summaries and chat with Groq.'),
    ).toBeVisible();
    expect(
      within(setup).getByRole('button', { name: 'How to get a Groq API key' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(within(setup).queryByRole('list')).toBeNull();
  });

  it('a Verify that passes says the key works, without pointing at a model list', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    const props = mount(sectionProps({ keys: ['Groq'] }));
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    await userEvent.click(within(setup).getByRole('button', { name: 'Verify' }));
    expect(await within(setup).findByText('Verified. Groq accepted the key.')).toBeVisible();
    expect(props.model.calls).toEqual([{ name: 'verifyApiKey', kind: 'Groq' }]);
  });

  it('offers the models of the provider table, the default first, and saves another one', async () => {
    const api = installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'] }));
    const picker = await screen.findByRole('combobox', { name: 'Transcription model' });
    expect(picker).toHaveTextContent('Whisper Large v3 Turbo');
    await userEvent.click(picker);
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(['Whisper Large v3 Turbo', 'Whisper Large v3']);
    await userEvent.click(screen.getByRole('option', { name: 'Whisper Large v3' }));
    await waitFor(() => {
      expect(updates(api)).toEqual([{ patch: { cloudTranscriptionModelId: 'whisper-large-v3' } }]);
    });
  });

  it('a saved model this engine does not list is not offered: the default is shown', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    // Saved while another engine was selected, or typed into the settings file.
    mount(sectionProps({ keys: ['Groq'], cloudModel: 'nova-3' }));
    const picker = await screen.findByRole('combobox', { name: 'Transcription model' });
    expect(picker).toHaveTextContent('Whisper Large v3 Turbo');
    await userEvent.click(picker);
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Whisper Large v3 Turbo',
      'Whisper Large v3',
    ]);
  });

  it('says live captions arrive a few seconds late, and leaves the switch usable', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqReady });
    mount(sectionProps({ keys: ['Groq'] }));
    const live = await screen.findByRole('switch', { name: 'Live transcription during recording' });
    await waitFor(() => {
      expect(live).toBeChecked();
    });
    expect(live).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('group', { name: 'Live transcription during recording' }),
    ).toHaveAccessibleDescription(
      'Shows captions on screen while you record. With Groq the text appears a few seconds after it is said.',
    );
  });

  it('shows speaker labels disabled with the reason, keeping the saved switch', async () => {
    const api = installTranscriptionApi({
      'transcription.getStatus': () => ({ ...groqReady, speakerLabelsEnabled: true }),
    });
    mount(sectionProps({ keys: ['Groq'] }));
    const labels = await screen.findByRole('switch', { name: 'Speaker labels' });
    await waitFor(() => {
      expect(labels).toHaveAttribute('aria-disabled', 'true');
    });
    // The saved choice is shown, not cleared.
    expect(labels).toBeChecked();
    const reason =
      'Not available with Groq in this version. Your choice is kept for when you transcribe on this PC.';
    expect(labels).toHaveAccessibleDescription(reason);
    expect(screen.getByRole('group', { name: 'Speaker labels' })).toHaveAccessibleDescription(
      reason,
    );
    await userEvent.click(labels);
    expect(api.calls.some((call) => call.name === 'transcription.setSpeakerLabels')).toBe(false);
  });
});

describe('TranscriptionSection: Deepgram, a provider that only transcribes', () => {
  const deepgramNoKey = {
    ...baseStatus,
    engine: 'Deepgram',
    ready: false,
    cloudNotReadyReason: 'key-missing',
  };
  const deepgramReady = { ...baseStatus, engine: 'Deepgram', ready: true };

  it('names the provider the audio goes to and saves the key for Deepgram', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramNoKey });
    const props = mount();
    const setup = await screen.findByRole('group', { name: 'Deepgram setup' });
    expect(
      within(setup).getByText(
        'While Deepgram is selected, the audio of each meeting is sent to Deepgram to be turned into text.',
      ),
    ).toBeVisible();
    const key = within(setup).getByLabelText('API key', { selector: 'input' });
    await userEvent.type(key, 'dg-test-123');
    await userEvent.click(within(setup).getByRole('button', { name: 'Save key' }));
    expect(props.model.calls).toEqual([
      { name: 'setApiKey', kind: 'Deepgram', key: 'dg-test-123' },
    ]);
    expect(await within(setup).findByText('Key saved.')).toBeVisible();
  });

  it('links the Deepgram console in the key guide', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramNoKey });
    mount();
    const setup = await screen.findByRole('group', { name: 'Deepgram setup' });
    expect(
      within(setup).getByRole('button', { name: 'How to get a Deepgram API key' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(setup).getByRole('link', { name: /Open the Deepgram API keys page/ }),
    ).toHaveAttribute('href', 'https://console.deepgram.com/');
  });

  it('says the key only transcribes, never that it serves summaries and chat', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramReady });
    mount(sectionProps({ keys: ['Deepgram'] }));
    const setup = await screen.findByRole('group', { name: 'Deepgram setup' });
    expect(
      within(setup).getByText(
        'This key is used only to transcribe. Summaries and chat use the engine you choose for them.',
      ),
    ).toBeVisible();
    expect(within(setup).queryByText(/also works for summaries and chat/)).toBeNull();
    expect(within(setup).getByRole('button', { name: 'Remove key' })).toBeEnabled();
  });

  it('Verify and Remove go to Deepgram, and a Verify that passes says the key works', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramReady });
    const props = mount(sectionProps({ keys: ['Deepgram'] }));
    const setup = await screen.findByRole('group', { name: 'Deepgram setup' });
    await userEvent.click(within(setup).getByRole('button', { name: 'Verify' }));
    expect(await within(setup).findByText('Verified. Deepgram accepted the key.')).toBeVisible();
    await userEvent.click(within(setup).getByRole('button', { name: 'Remove key' }));
    expect(props.model.calls).toEqual([
      { name: 'verifyApiKey', kind: 'Deepgram' },
      { name: 'clearApiKey', kind: 'Deepgram' },
    ]);
  });

  it('names Nova-3 as its one model, with nothing to choose', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramReady });
    // A model saved while Groq was the engine is not shown, and is not what Deepgram is asked for.
    mount(sectionProps({ keys: ['Deepgram'], cloudModel: 'whisper-large-v3-turbo' }));
    const setup = await screen.findByRole('group', { name: 'Deepgram setup' });
    const row = within(setup).getByRole('group', { name: 'Transcription model' });
    expect(row).toHaveTextContent('Nova-3');
    expect(row).toHaveAccessibleDescription('The speech model Deepgram uses to transcribe.');
    expect(within(setup).queryByRole('combobox')).toBeNull();
    expect(within(setup).queryByText(/whisper/i)).toBeNull();
  });

  it('says live captions appear as you speak', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramReady });
    mount(sectionProps({ keys: ['Deepgram'] }));
    const live = await screen.findByRole('switch', { name: 'Live transcription during recording' });
    await waitFor(() => {
      expect(live).toBeChecked();
    });
    expect(
      screen.getByRole('group', { name: 'Live transcription during recording' }),
    ).toHaveAccessibleDescription(
      'Shows captions on screen while you record. With Deepgram the text appears as you speak.',
    );
  });

  it('keeps speaker labels off with the reason, as with every cloud engine', async () => {
    installTranscriptionApi({
      'transcription.getStatus': () => ({ ...deepgramReady, speakerLabelsEnabled: true }),
    });
    mount(sectionProps({ keys: ['Deepgram'] }));
    const labels = await screen.findByRole('switch', { name: 'Speaker labels' });
    await waitFor(() => {
      expect(labels).toHaveAttribute('aria-disabled', 'true');
    });
    expect(labels).toHaveAccessibleDescription(
      'Not available with Deepgram in this version. Your choice is kept for when you transcribe on this PC.',
    );
  });

  it('without its key the live switch asks for the key, and with it nothing is in the way', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => deepgramNoKey });
    mount();
    const live = await screen.findByRole('switch', { name: 'Live transcription during recording' });
    await waitFor(() => {
      expect(live).toHaveAttribute('aria-disabled', 'true');
    });
    expect(
      screen.getByRole('group', { name: 'Live transcription during recording' }),
    ).toHaveAccessibleDescription('Add your Deepgram API key to use this.');
    // The only notice in the setup is where the audio goes.
    const setup = screen.getByRole('group', { name: 'Deepgram setup' });
    expect(within(setup).queryByText(/cannot transcribe/)).toBeNull();
  });
});

describe('TranscriptionSection: the local engine while a cloud engine is selected', () => {
  const ENGINE = 'Nemotron 3.5 ASR Streaming 0.6B';
  const noLocal = {
    ...groqReady,
    modelInstalled: false,
    runtimes: { cpu: false, cuda: false },
  };

  it('stays in the section as a secondary row that says it is not in use', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => noLocal });
    mount(sectionProps({ keys: ['Groq'] }));
    const row = await screen.findByRole('group', { name: 'Engine on this PC' });
    expect(row).toHaveAccessibleDescription(
      'Not in use while Groq is selected. Download it if you want to transcribe on this PC later.',
    );
    // The cloud engine is ready, yet the local one is still reported as it is on disk.
    expect(within(row).getByText('Not installed')).toBeVisible();
    expect(within(row).getByRole('button', { name: `Download ${ENGINE}` })).toBeEnabled();
    expect(within(row).queryByRole('button', { name: `Delete ${ENGINE}` })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Transcription engine' })).toBeNull();
  });

  it('Download asks main for the local engine by name, since the selected one downloads nothing', async () => {
    const api = installTranscriptionApi({
      'transcription.getStatus': () => noLocal,
      'transcription.ensureEngine': () => ({ status: 'ready' }),
    });
    mount(sectionProps({ keys: ['Groq'] }));
    await userEvent.click(await screen.findByRole('button', { name: `Download ${ENGINE}` }));
    await waitFor(() => {
      expect(api.calls.find((call) => call.name === 'transcription.ensureEngine')?.input).toEqual({
        local: true,
      });
    });
  });

  it('with this PC selected, Download keeps sharing the transfer of the Record gate', async () => {
    const api = installTranscriptionApi({
      'transcription.getStatus': () => ({ ...noLocal, engine: 'Local', ready: false }),
      'transcription.ensureEngine': () => ({ status: 'ready' }),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: `Download ${ENGINE}` }));
    await waitFor(() => {
      expect(api.calls.find((call) => call.name === 'transcription.ensureEngine')?.input).toEqual(
        {},
      );
    });
  });

  it('shows an installed local engine as installed and deletable', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    mount();
    const row = await screen.findByRole('group', { name: 'Engine on this PC' });
    expect(within(row).getByText('Installed')).toBeVisible();
    expect(within(row).getByRole('button', { name: `Download ${ENGINE}` })).toBeDisabled();
    expect(within(row).getByRole('button', { name: `Delete ${ENGINE}` })).toBeEnabled();
  });
});

describe('TranscriptionSection: links from the Record page', () => {
  it('a link to the key puts the focus in the key field', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    openTranscriptionInSettings('key');
    mount();
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    await waitFor(() => {
      expect(within(setup).getByLabelText('API key', { selector: 'input' })).toHaveFocus();
    });
  });

  it('a link to the choice puts the focus on the engine in use and selects nothing', async () => {
    const api = installTranscriptionApi();
    openTranscriptionInSettings('choice');
    mount();
    const group = await choice();
    await waitFor(() => {
      expect(within(group).getByRole('radio', { name: /^On this PC/ })).toHaveFocus();
    });
    expect(updates(api)).toEqual([]);
  });

  it('a link that arrives while the section is on screen is followed too', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    mount();
    const setup = await screen.findByRole('group', { name: 'Groq setup' });
    expect(within(setup).getByLabelText('API key', { selector: 'input' })).not.toHaveFocus();
    openTranscriptionInSettings('key');
    await waitFor(() => {
      expect(within(setup).getByLabelText('API key', { selector: 'input' })).toHaveFocus();
    });
  });
});

describe('TranscriptionSection: Spanish', () => {
  it('names the choice, the notice and the guide in Spanish', async () => {
    installTranscriptionApi({ 'transcription.getStatus': () => groqNoKey });
    mount(sectionProps(), 'es');
    const setup = await screen.findByRole('group', { name: 'Configuración de Groq' });
    expect(
      screen.getByRole('radiogroup', { name: 'Dónde se transcriben las reuniones' }),
    ).toBeVisible();
    expect(
      within(setup).getByText(
        'Mientras Groq esté seleccionado, el audio de cada reunión se envía a Groq para convertirlo en texto.',
      ),
    ).toBeVisible();
    expect(
      within(setup).getByRole('link', { name: /Abre la página de claves de API de Groq/ }),
    ).toHaveAttribute('href', 'https://console.groq.com/keys');
  });

  it('words Deepgram in Spanish: the choice, the key hint and the live captions', async () => {
    installTranscriptionApi({
      'transcription.getStatus': () => ({ ...baseStatus, engine: 'Deepgram', ready: true }),
    });
    mount(sectionProps({ keys: ['Deepgram'] }), 'es');
    const setup = await screen.findByRole('group', { name: 'Configuración de Deepgram' });
    expect(
      screen.getByText(
        'En la nube, con tu propia clave de API de Deepgram. El texto aparece mientras hablas.',
      ),
    ).toBeVisible();
    expect(
      within(setup).getByText(
        'Esta clave solo se usa para transcribir. Los resúmenes y el chat usan el motor que elijas para ellos.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('group', { name: 'Transcripción en vivo durante la grabación' }),
    ).toHaveAccessibleDescription(
      'Muestra subtítulos en pantalla mientras grabas. Con Deepgram, el texto aparece mientras hablas.',
    );
  });
});
