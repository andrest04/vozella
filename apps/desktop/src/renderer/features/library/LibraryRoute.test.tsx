// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatMeetingTime } from './format';
import { useLibraryStore } from './library-store';
import { Providers } from '../../app/test-providers';
import {
  LibraryScreen,
  stubLayout,
  folderRecord,
  installFakeApi,
  meetingRecord,
} from './library-test-kit';

beforeAll(() => {
  // jsdom has no layout: report a wide page so the folder pane is inline.
  class FakeResizeObserver {
    observe(): void {
      // jsdom has no layout to observe.
    }
    disconnect(): void {
      // Nothing was observed.
    }
    unobserve(): void {
      // Nothing was observed.
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver;
  stubLayout();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => pageWidth,
  });
});

let pageWidth = 900;
afterEach(() => {
  pageWidth = 900;
});

function rowOf(name: RegExp): HTMLElement {
  return screen.getByRole('row', { name });
}
const UNI = '11111111-1111-4111-8111-111111111111';
const CALC = '22222222-2222-4222-8222-222222222222';

async function mount(setup?: (api: ReturnType<typeof installFakeApi>) => void) {
  const api = installFakeApi();
  setup?.(api);
  const user = userEvent.setup();
  render(
    <Providers>
      <LibraryScreen />
    </Providers>,
  );
  await waitFor(() => {
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
  return { api, user };
}

const seed = ({ meetings, folders }: ReturnType<typeof installFakeApi>): void => {
  folders.folders = [
    folderRecord(UNI, 'Universidad', null, { note: 'Fall term', colorKey: 'teal' }),
    folderRecord(CALC, 'Calculo', UNI),
  ];
  meetings.records.set(
    'a',
    meetingRecord('a', 'Standup', '2026-09-01T09:00:00.0000000+00:00', {
      summary: '## Plan\nShip the release',
    }),
  );
  meetings.records.set(
    'b',
    meetingRecord('b', 'Planning', '2026-09-03T09:00:00.0000000+00:00', { projectId: UNI }),
  );
  meetings.records.set(
    'c',
    meetingRecord('c', 'Review', '2026-09-02T09:00:00.0000000+00:00', { projectId: 'gone' }),
  );
};

describe('empty states', () => {
  it('shows the empty library with a way to record', async () => {
    const { api, user } = await mount();
    expect(screen.getByText('No meetings recorded yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record a meeting' }));
    expect(api.actions).toContainEqual({ type: 'navigateTo', tag: 'Recording' });
  });
});

describe('the list', () => {
  it('opens a meeting on the transcript and the summary through the workspace', async () => {
    const { api, user } = await mount(seed);
    await user.dblClick(rowOf(/Standup/));
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('a');
    });
    expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Transcript' });

    const row = rowOf(/Review/);
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open summary' }));
    await waitFor(() => {
      expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Summary' });
    });
    expect(api.workspace.state.selectedMeetingId).toBe('c');
  });
});

describe('moving and deleting a meeting', () => {
  it('refuses a busy meeting before asking, then deletes after confirming', async () => {
    const { api, user } = await mount(seed);
    api.busy.register({ isBusy: (id) => id === 'a' });
    const row = rowOf(/Standup/);
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(
      await screen.findByText(
        'This meeting is still being recorded or processed. Try again when it finishes.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.meetings.records.has('a')).toBe(true);

    const other = rowOf(/Review/);
    await user.click(within(other).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    expect(
      within(dialog).getByText('This moves "Review" and its recording to the Recycle Bin.'),
    ).toBeInTheDocument();
    // The safe choice has the focus.
    // The dialog moves the focus just after it appears.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(api.meetings.records.has('c')).toBe(false);
    });
    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /Review/ })).not.toBeInTheDocument();
    });
  });

  it('reports a locked recording and keeps the meeting listed', async () => {
    const { api, user } = await mount(seed);
    api.meetings.lockedIds.add('c');
    const row = rowOf(/Review/);
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/The meeting was not deleted/)).toBeInTheDocument();
    expect(rowOf(/Review/)).toBeInTheDocument();
  });

  it('offers a permanent delete only when the Recycle Bin refused, and asks again', async () => {
    const { api, user } = await mount(seed);
    api.meetings.trashRefusedIds.add('c');
    const row = rowOf(/Review/);
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const first = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    await user.click(within(first).getByRole('button', { name: 'Delete' }));

    const second = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(
      within(second).getByText(
        '"Review" could not go to the Recycle Bin. A permanent delete cannot be undone.',
      ),
    ).toBeInTheDocument();
    expect(api.meetings.records.has('c')).toBe(true);
    // The dialog moves the focus just after it appears.
    await waitFor(() => {
      expect(within(second).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    await user.click(within(second).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(api.meetings.records.has('c')).toBe(false);
    });
  });

  it('keeps the meeting when the permanent delete is cancelled', async () => {
    const { api, user } = await mount(seed);
    api.meetings.trashRefusedIds.add('c');
    const row = rowOf(/Review/);
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const first = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    await user.click(within(first).getByRole('button', { name: 'Delete' }));
    const second = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    await user.click(within(second).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(api.meetings.records.has('c')).toBe(true);
  });
});

describe('the All view', () => {
  it('opens on All with every meeting', async () => {
    await mount(seed);
    expect(rowOf(/Planning/)).toBeInTheDocument();
    expect(rowOf(/Standup/)).toBeInTheDocument();
    expect(rowOf(/Review/)).toBeInTheDocument();
  });

  it('asks to record when nothing is recorded, even with folders', async () => {
    await mount((api) => {
      api.folders.folders = [folderRecord(UNI, 'Universidad')];
    });
    expect(screen.getByText('No meetings recorded yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record a meeting' })).toBeInTheDocument();
  });

  it('carries out a folder action asked for from the sidebar', async () => {
    const { user } = await mount(seed);
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    expect(await screen.findByRole('dialog', { name: 'New folder' })).toBeInTheDocument();
    await waitFor(() => {
      expect(useLibraryStore.getState().folderRequest).toBeNull();
    });
  });
});

describe('the grid', () => {
  const noLength = '2026-09-01T09:00:00.0000000+00:00';
  const seedLengths = ({ meetings }: ReturnType<typeof installFakeApi>): void => {
    meetings.records.set(
      'long',
      meetingRecord('long', 'Long', noLength, { endedAt: '2026-09-01T10:00:00.0000000+00:00' }),
    );
    meetings.records.set('open', meetingRecord('open', 'Open', noLength));
  };

  it('is a grid with row counts, day headers and one tab stop', async () => {
    await mount(seed);
    const grid = screen.getByRole('grid', { name: 'Library' });
    // Three days, three meetings.
    expect(grid).toHaveAttribute('aria-rowcount', '6');
    expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    const rows = within(grid).getAllByRole('row');
    expect(rows.map((row) => row.getAttribute('aria-rowindex'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(3);
    const stops = within(grid)
      .getAllByRole('row')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent('Planning');
  });

  it('shows a length and a ruling only for a meeting with an end', async () => {
    await mount(seedLengths);
    const long = rowOf(/Long/);
    expect(within(long).getByText('60 min')).toBeInTheDocument();
    const ruling = long.querySelector<HTMLElement>('[data-ruling]');
    expect(ruling).toHaveAttribute('aria-hidden', 'true');
    // sqrt(60 / 120) of 64 px.
    expect(ruling?.style.width).toBe('45px');
    const open = rowOf(/Open/);
    expect(open.querySelector('[data-ruling]')).toBeNull();
    expect(within(open).queryByText(/min/)).not.toBeInTheDocument();
  });

  it('arrows move the cursor and the focus over headers, and Enter opens', async () => {
    const { api, user } = await mount(seed);
    act(() => {
      rowOf(/Planning/).focus();
    });
    expect(rowOf(/Planning/)).toHaveAttribute('data-cursor', 'true');
    await user.keyboard('{ArrowDown}');
    expect(rowOf(/Review/)).toHaveFocus();
    expect(rowOf(/Review/)).toHaveAttribute('data-cursor', 'true');
    expect(rowOf(/Planning/)).not.toHaveAttribute('data-cursor');
    // Moving previews later; here it does not leave the screen or tell the workspace anything.
    expect(api.actions).not.toContainEqual({ type: 'openSession', tab: 'Transcript' });
    await user.keyboard('{End}');
    expect(rowOf(/Standup/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rowOf(/Planning/)).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('b');
    });
  });

  it('Tab goes from the cursor row to its actions, and only those', async () => {
    const { user } = await mount(seed);
    act(() => {
      rowOf(/Planning/).focus();
    });
    await user.tab();
    expect(within(rowOf(/Planning/)).getByRole('button', { name: 'More actions' })).toHaveFocus();
    await user.tab();
    expect(rowOf(/Review/)).not.toHaveFocus();
    expect(within(rowOf(/Review/)).getByRole('button', { name: 'More actions' })).not.toHaveFocus();
  });

  it('a click on a menu entry of a row does not open the meeting', async () => {
    const { api, user } = await mount(seed);
    await user.click(within(rowOf(/Standup/)).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move' }));
    await screen.findByRole('dialog', { name: 'Move meeting' });
    expect(api.actions).not.toContainEqual({ type: 'openSession', tab: 'Transcript' });
  });
});

describe('the header of the list', () => {
  it('keeps the count of the view while a search narrows the list', async () => {
    const { user } = await mount(seed);
    await user.type(screen.getByRole('searchbox'), 'stand');
    expect(screen.getByTestId('library-view-count')).toHaveTextContent('3');
  });
});

describe('the panes', () => {
  it('shows the list beside the preview pane when the content is wide enough', async () => {
    pageWidth = 760;
    await mount(seed);
    expect(screen.getByTestId('library-preview')).toBeInTheDocument();
  });

  it('shows only the list below that width, and a click still opens the meeting', async () => {
    pageWidth = 759;
    const { api, user } = await mount(seed);
    expect(screen.queryByTestId('library-preview')).not.toBeInTheDocument();
    await user.click(screen.getByText('Standup'));
    await waitFor(() => {
      expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Transcript' });
    });
  });
});

describe('the preview', () => {
  const preview = (): HTMLElement => screen.getByTestId('library-preview');
  const reads = (api: ReturnType<typeof installFakeApi>) =>
    api.calls.filter((c) => c.name === 'library.getMeeting');

  it('previews the newest meeting on arrival, and a click only moves it', async () => {
    const { api, user } = await mount(seed);
    expect(
      await within(preview()).findByRole('heading', { level: 2, name: 'Planning' }),
    ).toBeInTheDocument();
    await user.click(rowOf(/Standup/));
    expect(
      await within(preview()).findByRole('heading', { level: 2, name: 'Standup' }),
    ).toBeInTheDocument();
    expect(await within(preview()).findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(rowOf(/Standup/)).toHaveAttribute('data-cursor', 'true');
    expect(api.actions).not.toContainEqual({ type: 'openSession', tab: 'Transcript' });
    // Previewing tells the workspace nothing: selectMeeting emits a scope change on each arrow.
    expect(api.actions.filter((a) => a.type === 'selectMeeting')).toEqual([]);
  });

  it('double click and Open meeting open it', async () => {
    const { api, user } = await mount(seed);
    await user.dblClick(rowOf(/Review/));
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('c');
    });
    expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Transcript' });

    await user.click(rowOf(/Standup/));
    await within(preview()).findByRole('heading', { level: 2, name: 'Standup' });
    await user.click(within(preview()).getByRole('button', { name: 'Open meeting' }));
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('a');
    });
    expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Summary' });
  });

  it('says when it happened, in a plain sentence', async () => {
    await mount(({ meetings }) => {
      meetings.records.set(
        'a',
        meetingRecord('a', 'Roadmap', '2026-09-01T10:30:00.0000000+00:00', {
          endedAt: '2026-09-01T11:15:00.0000000+00:00',
        }),
      );
    });
    const start = formatMeetingTime('2026-09-01T10:30:00.0000000+00:00', 'en');
    const end = formatMeetingTime('2026-09-01T11:15:00.0000000+00:00', 'en');
    expect(
      await within(preview()).findByText(new RegExp(`, ${start} to ${end}$`)),
    ).toBeInTheDocument();
  });

  it('shows the start of the transcript when there is no summary, and no tabs', async () => {
    await mount(({ meetings }) => {
      meetings.records.set(
        'a',
        meetingRecord('a', 'Sync', '2026-09-01T09:00:00.0000000+00:00', {
          transcript: '[00:01.00-00:02.00] Hello everyone',
        }),
      );
    });
    expect(await within(preview()).findByText(/Hello everyone/)).toBeInTheDocument();
    expect(within(preview()).queryByRole('tab')).not.toBeInTheDocument();
    expect(within(preview()).queryByText(/00:01/)).not.toBeInTheDocument();
  });

  it('has a tab each when both exist, with action items, attendees and the recording', async () => {
    const { api, user } = await mount(({ meetings }) => {
      meetings.records.set(
        'a',
        meetingRecord('a', 'Sync', '2026-09-01T09:00:00.0000000+00:00', {
          summary: 'Agreed to ship',
          transcript: '[00:01.00-00:02.00] Hello everyone',
          actionItems: [{ text: 'Send the notes', isDone: false }],
          attendees: ['Ana', 'Luis'],
          audioFilePath: 'C:\\Meetings\\Inbox\\sync.wav',
        }),
      );
    });
    expect(await within(preview()).findByText('Agreed to ship')).toBeInTheDocument();
    expect(within(preview()).getByText('Send the notes')).toBeInTheDocument();
    expect(within(preview()).getByText('Ana, Luis')).toBeInTheDocument();
    expect(within(preview()).getByText('sync.wav')).toBeInTheDocument();
    await user.click(within(preview()).getByRole('tab', { name: 'Transcript' }));
    expect(await within(preview()).findByText(/Hello everyone/)).toBeInTheDocument();
    await user.click(within(preview()).getByRole('button', { name: 'Open meeting' }));
    await waitFor(() => {
      expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Transcript' });
    });
  });

  it('waits for the arrows to settle before it reads a meeting', async () => {
    const { api, user } = await mount(seed);
    await within(preview()).findByRole('heading', { level: 2, name: 'Planning' });
    const before = reads(api).length;
    act(() => {
      rowOf(/Planning/).focus();
    });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(rowOf(/Standup/)).toHaveFocus();
    await within(preview()).findByRole('heading', { level: 2, name: 'Standup' });
    expect(reads(api).length - before).toBe(1);
  });

  it('a slow answer for an earlier row does not replace a later one', async () => {
    const { api, user } = await mount(seed);
    await within(preview()).findByRole('heading', { level: 2, name: 'Planning' });
    const get = api.meetings.get.bind(api.meetings);
    let release: () => void = () => undefined;
    const spy = vi.spyOn(api.meetings, 'get').mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return get(id);
    });
    await user.click(rowOf(/Review/));
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    await user.click(rowOf(/Standup/));
    await within(preview()).findByRole('heading', { level: 2, name: 'Standup' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(within(preview()).getByRole('heading', { level: 2 })).toHaveTextContent('Standup');
  });

  it('uses what it already read, and reads again after a change', async () => {
    const { api, user } = await mount(seed);
    await within(preview()).findByRole('heading', { level: 2, name: 'Planning' });
    await user.click(rowOf(/Standup/));
    await within(preview()).findByRole('heading', { level: 2, name: 'Standup' });
    const before = reads(api).length;
    await user.click(rowOf(/Planning/));
    expect(within(preview()).getByRole('heading', { level: 2 })).toHaveTextContent('Planning');
    expect(reads(api)).toHaveLength(before);

    const record = api.meetings.records.get('b');
    if (!record) throw new Error('no record');
    api.meetings.records.set('b', { ...record, summary: 'Changed elsewhere' });
    api.emit('library.changed', { reason: 'meeting' });
    expect(await within(preview()).findByText('Changed elsewhere')).toBeInTheDocument();
  });

  it('shows a skeleton only when a read takes a while', async () => {
    const { api, user } = await mount(seed);
    await within(preview()).findByRole('heading', { level: 2, name: 'Planning' });
    vi.spyOn(api.meetings, 'get').mockImplementationOnce(() => new Promise(() => undefined));
    await user.click(rowOf(/Standup/));
    expect(within(preview()).queryByRole('status')).not.toBeInTheDocument();
    expect(await within(preview()).findByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('says so when the meeting cannot be read', async () => {
    await mount(({ meetings }) => {
      meetings.records.set('a', meetingRecord('a', 'Sync', '2026-09-01T09:00:00.0000000+00:00'));
      vi.spyOn(meetings, 'get').mockResolvedValue(null);
    });
    expect(
      await within(preview()).findByText('This meeting could not be read.'),
    ).toBeInTheDocument();
  });

  it('has nothing to preview in an empty view', async () => {
    await mount();
    expect(preview()).toBeEmptyDOMElement();
  });

  it('does not read anything below the width, where there is no preview', async () => {
    pageWidth = 759;
    const { api } = await mount(seed);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reads(api)).toEqual([]);
  });
});

describe('searching inside meetings', () => {
  const searches = (api: ReturnType<typeof installFakeApi>) =>
    api.calls.filter((c) => c.name === 'library.search');
  const seedBodies = ({ meetings, folders }: ReturnType<typeof installFakeApi>): void => {
    folders.folders = [folderRecord(UNI, 'Universidad')];
    meetings.records.set(
      'heard',
      meetingRecord('heard', 'Standup', '2026-09-03T09:00:00.0000000+00:00', {
        transcript: '[00:01.00-00:02.00] Cerramos el año fiscal',
      }),
    );
    meetings.records.set(
      'written',
      meetingRecord('written', 'Planning', '2026-09-02T09:00:00.0000000+00:00', {
        summary: 'The fiscal plan is ready',
        transcript: '[00:01.00-00:02.00] Hello',
      }),
    );
    meetings.records.set(
      'noted',
      meetingRecord('noted', 'Retro', '2026-09-01T09:00:00.0000000+00:00', {
        notes: 'Ask about fiscal dates',
        transcript: '[00:01.00-00:02.00] Hello',
      }),
    );
    meetings.records.set(
      'named',
      meetingRecord('named', 'Fiscal review', '2026-08-31T09:00:00.0000000+00:00', {
        projectId: UNI,
      }),
    );
    meetings.records.set(
      'other',
      meetingRecord('other', 'Lunch', '2026-08-30T09:00:00.0000000+00:00'),
    );
  };

  it('adds what it finds inside meetings to the title matches, in date order', async () => {
    const { api, user } = await mount(seedBodies);
    await user.type(screen.getByRole('searchbox'), 'fiscal');
    await waitFor(() => {
      expect(screen.getAllByRole('row').filter((row) => row.dataset.rowId).length).toBe(4);
    });
    const ids = screen
      .getAllByRole('row')
      .map((row) => row.dataset.rowId)
      .filter(Boolean);
    expect(ids).toEqual(['heard', 'written', 'noted', 'named']);
    // The debounce waits for the typing to stop.
    expect(searches(api).map((c) => c.input)).toEqual([
      { query: 'fiscal', scope: { kind: 'all' }, requestId: expect.any(Number) as unknown },
    ]);
  });

  it('shows the matching text with the words marked', async () => {
    const { user } = await mount(seedBodies);
    await user.type(screen.getByRole('searchbox'), 'ano fiscal');
    const row = await screen.findByRole('row', { name: /Standup/ });
    const marks = [...row.querySelectorAll('mark')].map((mark) => mark.textContent);
    expect(marks).toEqual(['año', 'fiscal']);
  });

  it('does not look inside for a single character', async () => {
    const { api, user } = await mount(seedBodies);
    await user.type(screen.getByRole('searchbox'), 'f');
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(searches(api)).toEqual([]);
    expect(rowOf(/Fiscal review/)).toBeInTheDocument();
  });

  it('says it is still looking before it says nothing matched', async () => {
    const { api, user } = await mount(seedBodies);
    let release: () => void = () => undefined;
    const search = api.service.search.bind(api.service);
    vi.spyOn(api.service, 'search').mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return search(input);
    });
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText('Searching inside meetings')).toBeInTheDocument();
    expect(screen.queryByText('No meetings match your search.')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(searches(api)).toHaveLength(1);
    });
    release();
    expect(await screen.findByText('No meetings match your search.')).toBeInTheDocument();
    expect(screen.queryByText('Searching inside meetings')).not.toBeInTheDocument();
  });

  it('opens a hit on its own tab, and the preview follows', async () => {
    const { api, user } = await mount(seedBodies);
    await user.type(screen.getByRole('searchbox'), 'fiscal');
    const preview = screen.getByTestId('library-preview');
    await user.click(await screen.findByRole('row', { name: /Planning/ }));
    expect(await within(preview).findByRole('tab', { name: 'Summary' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.dblClick(rowOf(/Planning/));
    await waitFor(() => {
      expect(api.actions).toContainEqual({ type: 'openSession', tab: 'Summary' });
    });
    await user.dblClick(rowOf(/Retro/));
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('noted');
    });
    expect(api.actions.filter((a) => a.type === 'openSession').at(-1)).toEqual({
      type: 'openSession',
      tab: 'Summary',
    });
    await user.dblClick(rowOf(/Standup/));
    await waitFor(() => {
      expect(api.workspace.state.selectedMeetingId).toBe('heard');
    });
    expect(api.actions.filter((a) => a.type === 'openSession').at(-1)).toEqual({
      type: 'openSession',
      tab: 'Transcript',
    });
  });

  it('a slow answer to an old query does not replace a newer one', async () => {
    const { api, user } = await mount(seedBodies);
    let release: () => void = () => undefined;
    const search = api.service.search.bind(api.service);
    vi.spyOn(api.service, 'search').mockImplementationOnce(async () => {
      const old = await search({ query: 'hello', scope: { kind: 'all' }, requestId: 0 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...old, requestId: 1, stale: false };
    });
    await user.type(screen.getByRole('searchbox'), 'hello');
    await waitFor(() => {
      expect(searches(api)).toHaveLength(1);
    });
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'cerramos');
    await screen.findByRole('row', { name: /Standup/ });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('row', { name: /Planning/ })).not.toBeInTheDocument();
  });

  it('keeps the title matches and says so when looking inside fails', async () => {
    const { api, user } = await mount(seedBodies);
    vi.spyOn(api.service, 'search').mockRejectedValue(new Error('disk gone'));
    await user.type(screen.getByRole('searchbox'), 'fiscal');
    expect(await screen.findByText('Only titles were searched.')).toBeInTheDocument();
    expect(rowOf(/Fiscal review/)).toBeInTheDocument();
  });

  it('clears the search with its button, and the focus stays in the field', async () => {
    const { user } = await mount(seedBodies);
    await user.type(screen.getByRole('searchbox'), 'fiscal');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(rowOf(/Lunch/)).toBeInTheDocument();
  });
});

describe('checking several meetings', () => {
  const check = (name: RegExp): HTMLElement =>
    within(rowOf(name)).getByRole('checkbox', { name: /Select/ });
  const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Checked meetings' });
  const seedMany = ({ meetings, folders }: ReturnType<typeof installFakeApi>): void => {
    folders.folders = [folderRecord(UNI, 'Universidad')];
    for (const [id, title, day] of [
      ['a', 'First', '03'],
      ['b', 'Second', '03'],
      ['c', 'Third', '02'],
      ['d', 'Fourth', '01'],
    ] as const) {
      meetings.records.set(id, meetingRecord(id, title, `2026-09-${day}T09:00:00.0000000+00:00`));
    }
  };

  it('a check marks the row as selected and shows the bar; a click does not disturb it', async () => {
    const { user } = await mount(seedMany);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'false');
    await user.click(check(/First/));
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'true');
    expect(check(/First/)).toHaveAttribute('aria-checked', 'true');
    expect(within(bar()).getByText('Checked: 1')).toBeInTheDocument();
    await user.click(rowOf(/Second/));
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Second/)).toHaveAttribute('aria-selected', 'false');
    expect(rowOf(/Second/)).toHaveAttribute('data-cursor', 'true');
    await user.click(within(bar()).getByRole('button', { name: 'Clear checks' }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('Ctrl and Shift clicks check, without opening, also below the narrow width', async () => {
    pageWidth = 759;
    const { api, user } = await mount(seedMany);
    await user.keyboard('{Control>}');
    await user.click(rowOf(/First/));
    await user.keyboard('{/Control}{Shift>}');
    await user.click(rowOf(/Third/));
    await user.keyboard('{/Shift}');
    expect(within(bar()).getByText('Checked: 3')).toBeInTheDocument();
    expect(rowOf(/Second/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Fourth/)).toHaveAttribute('aria-selected', 'false');
    expect(api.actions).not.toContainEqual({ type: 'openSession', tab: 'Transcript' });
  });

  it('the day header checks its day, and shows when only part of it is', async () => {
    const { user } = await mount(seedMany);
    const day = screen.getAllByRole('checkbox', { name: /Select all from/ })[0];
    if (!day) throw new Error('no day check');
    await user.click(check(/First/));
    expect(day).toHaveAttribute('aria-checked', 'mixed');
    await user.click(day);
    expect(day).toHaveAttribute('aria-checked', 'true');
    expect(within(bar()).getByText('Checked: 2')).toBeInTheDocument();
    await user.click(day);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('shows the work under way and holds the actions until it ends', async () => {
    const { api, user } = await mount(seedMany);
    let release: () => void = () => undefined;
    const run = api.service.deleteMeetings.bind(api.service);
    vi.spyOn(api.service, 'deleteMeetings').mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return run(input);
    });
    await user.click(check(/First/));
    await user.click(check(/Second/));
    await user.click(within(bar()).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 meetings?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(bar()).findByText('Deleting 2 meetings')).toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(within(bar()).getByRole('button', { name: 'Move' })).toBeDisabled();
    release();
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    });
    expect(api.meetings.records.has('a')).toBe(false);
  });

  it('offers a permanent delete only for the meetings the Recycle Bin refused', async () => {
    const { api, user } = await mount(seedMany);
    api.meetings.trashRefusedIds.add('b');
    await user.click(check(/First/));
    await user.click(check(/Second/));
    await user.click(within(bar()).getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete 2 meetings?' });
    expect(
      within(dialog).getByText('This moves them and their recordings to the Recycle Bin.'),
    ).toBeInTheDocument();
    // The dialog moves the focus just after it appears.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    dialog = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(
      within(dialog).getByText(
        '1 of these meetings could not go to the Recycle Bin. A permanent delete cannot be undone.',
      ),
    ).toBeInTheDocument();
    expect(api.meetings.records.has('a')).toBe(false);
    expect(api.meetings.records.has('b')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(api.meetings.records.has('b')).toBe(false);
    });
    expect(
      api.calls.filter((c) => c.name === 'library.deleteMeetings').map((c) => c.input),
    ).toEqual([
      { meetingIds: ['a', 'b'], mode: 'trash' },
      { meetingIds: ['b'], mode: 'permanent' },
    ]);
  });

  it('the row menu acts on the whole set from a checked row, and alone from another', async () => {
    const { user } = await mount(seedMany);
    await user.click(check(/First/));
    await user.click(check(/Second/));
    await user.click(within(rowOf(/First/)).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete 2 meetings?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await user.click(within(rowOf(/Third/)).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    expect(within(dialog).getByText(/"Third"/)).toBeInTheDocument();
  });

  it('forgets the checks on another view or another search', async () => {
    const { user } = await mount(seedMany);
    await user.click(check(/First/));
    await user.type(screen.getByRole('searchbox'), 'f');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(check(/First/));
    await user.click(screen.getByRole('treeitem', { name: /Inbox/ }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('a refresh keeps the checks of the meetings still there', async () => {
    const { api, user } = await mount(seedMany);
    await user.click(check(/First/));
    await user.click(check(/Second/));
    api.meetings.records.delete('a');
    api.emit('library.changed', { reason: 'meeting' });
    await waitFor(() => {
      expect(within(bar()).getByText('Checked: 1')).toBeInTheDocument();
    });
    expect(rowOf(/Second/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the keyboard', () => {
  const bar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Checked meetings' });
  const seedMany = ({ meetings }: ReturnType<typeof installFakeApi>): void => {
    for (const [id, title, day] of [
      ['a', 'First', '04'],
      ['b', 'Second', '03'],
      ['c', 'Third', '02'],
      ['d', 'Fourth', '01'],
    ] as const) {
      meetings.records.set(id, meetingRecord(id, title, `2026-09-${day}T09:00:00.0000000+00:00`));
    }
  };
  const focusRow = (name: RegExp): void => {
    act(() => {
      rowOf(name).focus();
    });
  };

  it('Space checks the row under the cursor, and again unchecks it', async () => {
    const { user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard(' ');
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/First/)).toHaveFocus();
    await user.keyboard(' ');
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'false');
  });

  it('Shift and an arrow grow the range, and coming back shrinks it', async () => {
    const { user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(rowOf(/Third/)).toHaveFocus();
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Second/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Third/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Fourth/)).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(rowOf(/Third/)).toHaveAttribute('aria-selected', 'false');
    expect(within(bar()).getByText('Checked: 2')).toBeInTheDocument();
  });

  it('an arrow alone moves the cursor and keeps the checks', async () => {
    const { user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard(' {ArrowDown}');
    expect(rowOf(/Second/)).toHaveFocus();
    expect(rowOf(/First/)).toHaveAttribute('aria-selected', 'true');
    expect(rowOf(/Second/)).toHaveAttribute('aria-selected', 'false');
  });

  it('Escape clears the checks first, then the search', async () => {
    const { user } = await mount(seedMany);
    await user.type(screen.getByRole('searchbox'), 'r');
    focusRow(/First/);
    await user.keyboard(' ');
    expect(bar()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('r');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(rowOf(/Second/)).toBeInTheDocument();
  });

  it('Ctrl+A checks every row of the list', async () => {
    const { user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard('{Control>}a{/Control}');
    expect(within(bar()).getByText('Checked: 4')).toBeInTheDocument();
  });

  it('Ctrl+A waits for the search inside meetings, and checks what it found', async () => {
    const { api, user } = await mount(({ meetings }) => {
      meetings.records.set(
        'a',
        meetingRecord('a', 'Fiscal plan', '2026-09-04T09:00:00.0000000+00:00'),
      );
      meetings.records.set(
        'b',
        meetingRecord('b', 'Sync', '2026-09-03T09:00:00.0000000+00:00', {
          transcript: '[00:01.00-00:02.00] the fiscal year',
        }),
      );
      meetings.records.set('c', meetingRecord('c', 'Lunch', '2026-09-02T09:00:00.0000000+00:00'));
    });
    let release: () => void = () => undefined;
    const search = api.service.search.bind(api.service);
    vi.spyOn(api.service, 'search').mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return search(input);
    });
    await user.type(screen.getByRole('searchbox'), 'fiscal');
    focusRow(/Fiscal plan/);
    await user.keyboard('{Control>}a{/Control}');
    // Still reading: nothing is checked on a partial list.
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(api.calls.some((c) => c.name === 'library.search')).toBe(true);
    });
    release();
    expect(await within(await screen.findByRole('toolbar')).findByText('Checked: 2')).toBeVisible();
  });

  it('Ctrl+F goes to the search with its text selected, and Ctrl+A stays its own there', async () => {
    const { user } = await mount(seedMany);
    await user.type(screen.getByRole('searchbox'), 'fi');
    focusRow(/First/);
    await user.keyboard('{Control>}f{/Control}');
    const box = screen.getByRole<HTMLInputElement>('searchbox');
    expect(box).toHaveFocus();
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 2]);
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('ArrowDown goes from the search to the list, and Escape clears the search in place', async () => {
    const { user } = await mount(seedMany);
    const box = screen.getByRole('searchbox');
    await user.type(box, 'fi');
    await waitFor(() => {
      expect(rowOf(/First/)).toHaveAttribute('data-cursor', 'true');
    });
    await user.keyboard('{ArrowDown}');
    expect(rowOf(/First/)).toHaveFocus();
    await user.click(box);
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
  });

  it('F2 renames the meeting under the cursor and the list follows', async () => {
    const { api, user } = await mount(seedMany);
    focusRow(/Second/);
    await user.keyboard('{F2}');
    const dialog = await screen.findByRole('dialog', { name: 'Rename meeting' });
    const field = within(dialog).getByRole('textbox');
    expect(field).toHaveValue('Second');
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    expect(await screen.findByRole('row', { name: /Renamed/ })).toBeInTheDocument();
    expect(api.meetings.records.get('b')?.title).toBe('Renamed');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(rowOf(/Renamed/)).toHaveFocus();
    });
  });

  it('F2 says why when a re-transcription blocks the rename', async () => {
    const { api, user } = await mount(seedMany);
    api.runner.isRunning = true;
    api.runner.meetingId = 'b';
    focusRow(/Second/);
    await user.keyboard('{F2}');
    const dialog = await screen.findByRole('dialog', { name: 'Rename meeting' });
    const field = within(dialog).getByRole('textbox');
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    expect(await within(dialog).findByText(/re-transcription to finish/)).toBeInTheDocument();
    expect(api.meetings.records.get('b')?.title).toBe('Second');
  });

  it('Delete asks about the row, and the next row takes the focus', async () => {
    const { api, user } = await mount(seedMany);
    focusRow(/Second/);
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    expect(within(dialog).getByText(/"Second"/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(api.meetings.records.has('b')).toBe(false);
    });
    await waitFor(() => {
      expect(rowOf(/Third/)).toHaveFocus();
    });
    expect(api.calls.find((c) => c.name === 'library.deleteMeeting')?.input).toEqual({
      meetingId: 'b',
      mode: 'trash',
    });
  });

  it('Delete refused by the bin still offers the permanent delete', async () => {
    const { api, user } = await mount(seedMany);
    api.meetings.trashRefusedIds.add('b');
    focusRow(/Second/);
    await user.keyboard('{Delete}');
    let dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(within(dialog).getByText(/could not go to the Recycle Bin/)).toBeInTheDocument();
  });

  it('Delete refuses a busy meeting before asking', async () => {
    const { api, user } = await mount(seedMany);
    api.busy.register({ isBusy: (id) => id === 'b' });
    focusRow(/Second/);
    await user.keyboard('{Delete}');
    expect(await screen.findByText(/still being recorded or processed/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Delete on a checked row asks about the whole set', async () => {
    const { user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard(' {ArrowDown} ');
    await user.keyboard('{Delete}');
    expect(await screen.findByRole('dialog', { name: 'Delete 2 meetings?' })).toBeInTheDocument();
  });

  it('Shift+Delete asks for a permanent delete directly, with its own words', async () => {
    const { api, user } = await mount(seedMany);
    focusRow(/Second/);
    await user.keyboard('{Shift>}{Delete}{/Shift}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(
      within(dialog).getByText(
        'This deletes "Second" and its recording. A permanent delete cannot be undone.',
      ),
    ).toBeInTheDocument();
    // The dialog moves the focus just after it appears.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(api.meetings.records.has('b')).toBe(false);
    });
    expect(api.calls.find((c) => c.name === 'library.deleteMeeting')?.input).toEqual({
      meetingId: 'b',
      mode: 'permanent',
    });
  });

  it('Shift+Delete on a checked row asks about the set, and refuses nothing silently', async () => {
    const { api, user } = await mount(seedMany);
    focusRow(/First/);
    await user.keyboard(' {ArrowDown} ');
    await user.keyboard('{Shift>}{Delete}{/Shift}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(
      within(dialog).getByText(
        'This deletes 2 meetings and their recordings. A permanent delete cannot be undone.',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(api.meetings.records.has('a')).toBe(false);
    });
    expect(api.calls.find((c) => c.name === 'library.deleteMeetings')?.input).toEqual({
      meetingIds: ['a', 'b'],
      mode: 'permanent',
    });
  });

  it('keys typed in a dialog or a menu do not reach the rows', async () => {
    const { api, user } = await mount(seedMany);
    await user.click(within(rowOf(/First/)).getByRole('button', { name: 'More actions' }));
    await screen.findByRole('menuitem', { name: 'Move' });
    await user.keyboard('{Delete}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    focusRow(/First/);
    await user.keyboard('{F2}');
    const dialog = await screen.findByRole('dialog', { name: 'Rename meeting' });
    await user.keyboard(' {Delete}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toBeInTheDocument();
    expect(api.calls.some((c) => c.name === 'library.deleteMeeting')).toBe(false);
  });
});

describe('dragging meetings to a folder', () => {
  const dataTransfer = () => {
    const data = new Map<string, string>();
    return {
      data,
      get types() {
        return [...data.keys()];
      },
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
      getData: (type: string) => data.get(type) ?? '',
      setDragImage: vi.fn(),
    };
  };
  const tree = (name: RegExp): HTMLElement => screen.getByRole('treeitem', { name });
  const seedDrag = ({ meetings, folders }: ReturnType<typeof installFakeApi>): void => {
    folders.folders = [folderRecord(UNI, 'Universidad'), folderRecord(CALC, 'Calculo', UNI)];
    for (const [id, title, day] of [
      ['a', 'First', '04'],
      ['b', 'Second', '03'],
      ['c', 'Third', '02'],
    ] as const) {
      meetings.records.set(id, meetingRecord(id, title, `2026-09-${day}T09:00:00.0000000+00:00`));
    }
  };
  it('Inbox is a target and All is not, and only meetings can land', async () => {
    const { api } = await mount(({ meetings, folders }) => {
      seedDrag({ meetings, folders } as never);
      const record = meetings.records.get('a');
      if (record) meetings.records.set('a', { ...record, projectId: UNI });
    });
    const transfer = dataTransfer();
    fireEvent.dragStart(rowOf(/First/), { dataTransfer: transfer });
    // fireEvent says false when the handler called preventDefault, which is what allows a drop.
    expect(fireEvent.dragOver(tree(/^All/), { dataTransfer: transfer })).toBe(true);
    expect(fireEvent.dragOver(tree(/Inbox/), { dataTransfer: transfer })).toBe(false);
    expect(transfer.dropEffect).toBe('move');
    expect(tree(/Inbox/)).toHaveAttribute('data-drop-target', 'true');
    fireEvent.dragLeave(tree(/Inbox/), { dataTransfer: transfer });
    expect(tree(/Inbox/)).not.toHaveAttribute('data-drop-target');
    expect(fireEvent.dragOver(tree(/Inbox/), { dataTransfer: { types: ['text/plain'] } })).toBe(
      true,
    );
    fireEvent.drop(tree(/Inbox/), { dataTransfer: transfer });
    await waitFor(() => {
      expect(api.meetings.records.get('a')?.projectId).toBeNull();
    });
  });
});
