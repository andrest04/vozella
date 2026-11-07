// @vitest-environment jsdom
import type { ChatRecipe } from '@vozella/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../library/library-test-kit';
import { StarterList } from './StarterList';

afterEach(cleanup);

const builtIn: ChatRecipe = {
  id: 'b1',
  name: 'Action items',
  prompt: 'List the action items.',
  availability: 'single',
};
const savedPrompt: ChatRecipe = {
  id: 'u1',
  name: 'Risk review',
  prompt: 'List the risks.',
  availability: 'single',
  owner: 'user',
  engine: 'codex',
};

function mount(recipes: readonly ChatRecipe[] = [savedPrompt, builtIn]) {
  const onPick = vi.fn();
  const onEdit = vi.fn();
  render(
    <Providers locale="en">
      <StarterList heading="About this meeting" recipes={recipes} onPick={onPick} onEdit={onEdit} />
    </Providers>,
  );
  return { onPick, onEdit };
}

const list = () => screen.getByRole('list', { name: 'About this meeting' });
const rows = () => within(list()).getAllByTestId('BtnChatStarter');

describe('StarterList', () => {
  it('shows the heading and names the list with it', () => {
    mount();
    expect(screen.getByText('About this meeting')).toBeVisible();
    expect(list()).toHaveAttribute('data-testid', 'ListMeetingChatStarters');
  });

  it('renders one list item per starter, in order, each with one send button', () => {
    mount();
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
    expect(rows().map((b) => b.textContent)).toEqual(['Risk review', 'Action items']);
  });

  it('renders nothing without starters', () => {
    mount([]);
    expect(screen.queryByTestId('ListMeetingChatStarters')).toBeNull();
    expect(screen.queryByText('About this meeting')).toBeNull();
  });

  it('a click on a row sends that starter', async () => {
    const { onPick, onEdit } = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Action items' }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(builtIn);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('only saved prompts get a pencil, labelled with the prompt name', () => {
    mount();
    const pencils = screen.getAllByTestId('BtnChatStarterEdit');
    expect(pencils).toHaveLength(1);
    expect(pencils[0]).toHaveAccessibleName('Edit Risk review');
    expect(screen.queryByRole('button', { name: 'Edit Action items' })).toBeNull();
  });

  it('the pencil opens the editor and does not send', async () => {
    const { onPick, onEdit } = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Risk review' }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(savedPrompt);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('the keyboard reaches the row, then its pencil, then the next row', async () => {
    const { onEdit } = mount();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Risk review' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Edit Risk review' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(savedPrompt);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Action items' })).toHaveFocus();
  });
});
