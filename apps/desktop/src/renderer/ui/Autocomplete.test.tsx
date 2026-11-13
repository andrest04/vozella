// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Autocomplete, type AutocompleteOption } from '.';

const OPTIONS: readonly AutocompleteOption[] = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { value: 'o9-preview', label: 'o9-preview' },
];

function Harness({
  initial = 'claude-opus-5-5',
  onCommit,
}: {
  readonly initial?: string;
  readonly onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <>
      <Autocomplete
        label="Model"
        openLabel="Show models"
        options={OPTIONS}
        value={text}
        onValueChange={setText}
        onCommit={onCommit}
        listTestId="ListModels"
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Model' });
const optionNames = () =>
  within(screen.getByTestId('ListModels'))
    .getAllByRole('option')
    .map((option) => option.textContent);

describe('Autocomplete', () => {
  it('shows every option when opened, even though the field already holds one of them', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const user = userEvent.setup();
    expect(field()).toHaveAttribute('aria-expanded', 'false');

    await user.click(field());
    expect(await screen.findByRole('listbox')).toBeVisible();
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(field()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('opens with ArrowDown or the chevron and lists everything', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show models' }));
    expect(await screen.findAllByRole('option')).toHaveLength(4);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    field().focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findAllByRole('option')).toHaveLength(4);
  });

  it('shows a readable name with the id beneath, and the id alone when they are the same', async () => {
    render(<Harness onCommit={vi.fn()} />);
    await userEvent.click(field());
    const opus = await screen.findByRole('option', { name: /Claude Opus 5\.5/ });
    expect(opus).toHaveTextContent('Claude Opus 5.5claude-opus-5-5');
    expect(screen.getByRole('option', { name: 'o9-preview' })).toHaveTextContent(/^o9-preview$/);
  });

  it('filters by name or id, ignoring case, once the user types', async () => {
    render(<Harness initial="" onCommit={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(field(), 'SONNET');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Claude Sonnet 5.5claude-sonnet-5-5']);
    });
    await user.clear(field());
    await user.type(field(), 'haiku-5');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Claude Haiku 5.5claude-haiku-5-5']);
    });
  });

  it('moves through the options with the arrows and commits the active one on Enter', async () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const user = userEvent.setup();
    field().focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const active = field().getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active ?? '')).toHaveTextContent('Claude Sonnet 5.5');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('claude-sonnet-5-5');
    expect(field()).toHaveValue('claude-sonnet-5-5');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('commits a clicked option once, with its id', async () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.click(await screen.findByRole('option', { name: /Claude Haiku 5\.5/ }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('claude-haiku-5-5');
    expect(field()).toHaveValue('claude-haiku-5-5');
  });

  it('accepts free text: Enter or leaving the field commits what was typed', async () => {
    const onCommit = vi.fn();
    render(<Harness initial="" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.type(field(), 'my-own-model{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith('my-own-model');

    await user.clear(field());
    await user.type(field(), 'another-model');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onCommit).toHaveBeenLastCalledWith('another-model');
  });

  it('shows the readable name of a known model at rest and its id while editing', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const user = userEvent.setup();
    expect(field()).toHaveValue('Claude Opus 5.5');
    expect(field()).toHaveAccessibleDescription('claude-opus-5-5');

    await user.click(field());
    expect(field()).toHaveValue('claude-opus-5-5');
    expect(field()).toHaveAccessibleDescription('Claude Opus 5.5');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(field()).toHaveValue('Claude Opus 5.5');
  });

  it('commits the id, never the readable name, when the field is left untouched', async () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onCommit).toHaveBeenLastCalledWith('claude-opus-5-5');
  });

  it('shows free text and same-named ids as they are, with no extra description', () => {
    const { unmount } = render(<Harness initial="my-own-model" onCommit={vi.fn()} />);
    expect(field()).toHaveValue('my-own-model');
    expect(field()).toHaveAccessibleDescription('');
    unmount();
    render(<Harness initial="o9-preview" onCommit={vi.fn()} />);
    expect(field()).toHaveValue('o9-preview');
    expect(field()).toHaveAccessibleDescription('');
  });

  it('shows a picked model by its readable name once the field is left', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.click(await screen.findByRole('option', { name: /Claude Haiku 5\.5/ }));
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(field()).toHaveValue('Claude Haiku 5.5');
  });

  it('Escape closes the list and keeps the text', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(field());
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    expect(field()).toHaveValue('claude-opus-5-5');
    await user.keyboard('{Escape}');
    expect(field()).toHaveValue('claude-opus-5-5');
  });
});
