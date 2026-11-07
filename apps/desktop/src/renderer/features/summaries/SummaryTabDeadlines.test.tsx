// @vitest-environment jsdom
import type { ActionItemDto } from '@vozella/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../library/library-test-kit';
import { SummaryTab } from './SummaryTab';
import { installSummariesApi, withSummary } from './summaries-test-kit';

beforeEach(() => {
  // Only the clock: the formatted dates drop the year in the current year.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 6, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'vozella');
});

const ITEMS: ActionItemDto[] = [
  {
    text: 'Bring the progress',
    isDone: false,
    owner: 'Ana',
    deadline: { quote: 'para la siguiente clase', kind: { type: 'next_meeting' } },
  },
  {
    text: 'Send the slides',
    isDone: false,
    owner: 'Luis',
    deadline: {
      quote: 'el viernes',
      kind: { type: 'weekday', weekday: 'fri' },
      date: '2026-11-13',
    },
  },
  {
    text: 'Check the budget',
    isDone: false,
    deadline: { quote: 'pronto', kind: { type: 'unknown' } },
  },
  {
    text: 'Book the room',
    isDone: true,
    deadline: { quote: 'el lunes', kind: { type: 'weekday', weekday: 'mon' }, date: '2026-11-09' },
  },
  { text: 'Plain item', isDone: false },
];

type Handlers = Parameters<typeof installSummariesApi>[0];

const install = (items: readonly ActionItemDto[] = ITEMS, handlers: Handlers = {}) =>
  installSummariesApi({
    'summaries.loadTab': () => ({
      status: 'loaded',
      state: withSummary('Summary text', { actionItems: items }),
      generating: false,
    }),
    ...handlers,
  });

const mount = (locale: 'en' | 'es' = 'en') =>
  render(
    <Providers locale={locale}>
      <SummaryTab meetingId="m1" />
    </Providers>,
  );

const calls = (api: ReturnType<typeof installSummariesApi>, name: string) =>
  api.calls.filter((call) => call.name === name);

const itemAt = async (index: number): Promise<HTMLElement> => {
  const items = within(await screen.findByTestId('ListActionItems')).getAllByRole('listitem');
  const found = items[index];
  if (!found) throw new Error('no action item at ' + String(index));
  return found;
};

/** The item at `index` with its deadline date set (or dropped with undefined). */
const dated = (index: number, date: string | undefined): ActionItemDto[] =>
  ITEMS.map((item, at) => {
    if (at !== index || !item.deadline) return item;
    const { quote, kind } = item.deadline;
    return { ...item, deadline: date === undefined ? { quote, kind } : { quote, kind, date } };
  });

const user = () => userEvent.setup();

describe('action item details', () => {
  it('shows the owner, the local date and the exact quote under the text', async () => {
    install();
    mount();
    const row = await itemAt(1);
    expect(within(row).getByTestId('ActionItemMeta')).toHaveTextContent(
      'Luis · Fri 13 Nov · “el viernes”',
    );
    expect(within(row).getByRole('checkbox', { name: 'Send the slides' })).not.toBeChecked();
  });

  it('speaks the date in Spanish', async () => {
    install();
    mount('es');
    const row = await itemAt(1);
    expect(within(row).getByTestId('ActionItemMeta')).toHaveTextContent('vie 13 nov');
  });

  it('never invents a date: an unknown deadline shows the quote and an Add date action', async () => {
    install();
    mount();
    const row = await itemAt(2);
    const meta = within(row).getByTestId('ActionItemMeta');
    expect(meta).toHaveTextContent('“pronto”');
    expect(within(meta).getByRole('button', { name: 'Add date' })).toBeVisible();
    expect(within(meta).queryByRole('button', { name: 'Clear date' })).toBeNull();
  });

  it('shows no detail line for an item without owner or deadline', async () => {
    install();
    mount();
    const row = await itemAt(4);
    expect(within(row).queryByTestId('ActionItemMeta')).toBeNull();
  });

  it('edits the date inline, saves it and shows the saved list', async () => {
    const saved = dated(1, '2026-11-20');
    const api = install(ITEMS, {
      'summaries.setActionItemDate': () => ({ status: 'saved', actionItems: saved }),
    });
    mount();
    const row = await itemAt(1);
    await user().click(within(row).getByRole('button', { name: 'Change the date, Fri 13 Nov' }));
    const input = within(row).getByLabelText('Due date for Send the slides');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('2026-11-13');
    fireEvent.change(input, { target: { value: '2026-11-20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(within(row).getByTestId('ActionItemMeta')).toHaveTextContent('Fri 20 Nov');
    });
    expect(calls(api, 'summaries.setActionItemDate')[0]?.input).toEqual({
      meetingId: 'm1',
      index: 1,
      date: '2026-11-20',
    });
    expect(within(row).getByRole('button', { name: 'Change the date, Fri 20 Nov' })).toHaveFocus();
  });

  it('Escape leaves the date as it was and sends nothing', async () => {
    const api = install();
    mount();
    const row = await itemAt(1);
    await user().click(within(row).getByRole('button', { name: 'Change the date, Fri 13 Nov' }));
    const input = within(row).getByLabelText('Due date for Send the slides');
    fireEvent.change(input, { target: { value: '2026-11-20' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(row).getByTestId('ActionItemMeta')).toHaveTextContent('Fri 13 Nov');
    expect(calls(api, 'summaries.setActionItemDate')).toHaveLength(0);
  });

  it('clears a date with its own button', async () => {
    const cleared = dated(1, undefined);
    const api = install(ITEMS, {
      'summaries.setActionItemDate': () => ({ status: 'saved', actionItems: cleared }),
    });
    mount();
    const row = await itemAt(1);
    await user().click(within(row).getByRole('button', { name: 'Clear date' }));
    expect(await within(row).findByRole('button', { name: 'Add date' })).toBeVisible();
    expect(calls(api, 'summaries.setActionItemDate')[0]?.input).toEqual({
      meetingId: 'm1',
      index: 1,
      date: null,
    });
  });

  it('says why when a date cannot be saved', async () => {
    install(ITEMS, {
      'summaries.setActionItemDate': () => ({
        status: 'failed',
        message: 'Disk full',
        detail: 'x',
      }),
    });
    mount();
    const row = await itemAt(1);
    await user().click(within(row).getByRole('button', { name: 'Clear date' }));
    expect(await screen.findByText('Disk full')).toBeVisible();
    expect(within(row).getByTestId('ActionItemMeta')).toHaveTextContent('Fri 13 Nov');
  });
});

describe('next session prompt', () => {
  it('asks once, saves the answer and fills the waiting items', async () => {
    const filled = dated(0, '2026-11-12');
    const api = install(ITEMS, {
      'summaries.setNextSessionDate': () => ({ status: 'saved', actionItems: filled, filled: 1 }),
    });
    mount();
    const prompt = await screen.findByTestId('NextSessionPrompt');
    expect(prompt).toHaveTextContent('meetings named “Weekly sync”');
    const input = within(prompt).getByLabelText('When is the next session?');
    fireEvent.change(input, { target: { value: '2026-11-12' } });
    await user().click(within(prompt).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByTestId('NextSessionPrompt')).toBeNull();
    });
    expect(calls(api, 'summaries.setNextSessionDate')[0]?.input).toEqual({
      meetingId: 'm1',
      date: '2026-11-12',
    });
    expect(within(await itemAt(0)).getByTestId('ActionItemMeta')).toHaveTextContent('Thu 12 Nov');
  });

  it('keeps Save off until a date is picked', async () => {
    install();
    mount();
    const prompt = await screen.findByTestId('NextSessionPrompt');
    expect(within(prompt).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a date on or before the meeting as an inline error', async () => {
    install(ITEMS, { 'summaries.setNextSessionDate': () => ({ status: 'invalid-date' }) });
    mount();
    const prompt = await screen.findByTestId('NextSessionPrompt');
    fireEvent.change(within(prompt).getByLabelText('When is the next session?'), {
      target: { value: '2026-11-01' },
    });
    await user().click(within(prompt).getByRole('button', { name: 'Save' }));
    expect(await within(prompt).findByText('Pick a date after this meeting.')).toBeVisible();
  });

  it('is not there when no item waits for the next session', async () => {
    install(ITEMS.slice(1));
    mount();
    await screen.findByTestId('ListActionItems');
    expect(screen.queryByTestId('NextSessionPrompt')).toBeNull();
  });
});

describe('calendar export', () => {
  it('exports the open dated items and says how many', async () => {
    const api = install(ITEMS, {
      'summaries.exportActionItemsIcs': () => ({ status: 'exported', count: 1 }),
    });
    mount();
    await user().click(await screen.findByRole('button', { name: 'Add to calendar (.ics)' }));
    expect(await screen.findByText('1 action item saved to the calendar file.')).toBeVisible();
    expect(calls(api, 'summaries.exportActionItemsIcs')[0]?.input).toEqual({
      meetingId: 'm1',
      indexes: [1],
    });
  });

  it('is off with a hint when no open item has a date', async () => {
    install(ITEMS.filter((item) => item.deadline?.date === undefined || item.isDone));
    mount();
    const button = await screen.findByRole('button', { name: 'Add to calendar (.ics)' });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('Set a date on an open item to add it to your calendar.'),
    ).toBeVisible();
  });

  it('reports a count, an empty answer and a failure; a cancelled dialog says nothing', async () => {
    let answer: unknown = { status: 'exported', count: 3 };
    install(ITEMS, { 'summaries.exportActionItemsIcs': () => answer });
    mount();
    const button = await screen.findByRole('button', { name: 'Add to calendar (.ics)' });
    await user().click(button);
    expect(await screen.findByText('3 action items saved to the calendar file.')).toBeVisible();

    answer = { status: 'empty' };
    await user().click(button);
    expect(await screen.findByText('None of these items has a date yet.')).toBeVisible();

    answer = { status: 'failed', message: 'Access denied' };
    await user().click(button);
    expect(
      await screen.findByText('Could not save the calendar file: Access denied'),
    ).toBeVisible();

    answer = { status: 'cancelled' };
    await user().click(button);
    await waitFor(() => {
      expect(screen.queryByTestId('DraftMessage')).toBeNull();
    });
  });

  it('speaks Spanish', async () => {
    install();
    mount('es');
    expect(
      await screen.findByRole('button', { name: 'Agregar al calendario (.ics)' }),
    ).toBeVisible();
    expect(screen.getByText('¿Cuándo es la próxima sesión?')).toBeVisible();
  });
});
