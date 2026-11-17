// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { formatMeetingDate } from '../meeting-list/format';
import { Providers } from '../../app/test-providers';
import {
  LibraryScreen,
  stubLayout,
  installFakeApi,
  meetingRecord,
  projectListItem,
} from './library-test-kit';

beforeAll(() => {
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
    get: () => 900,
  });
});

const UNI = '11111111-1111-4111-8111-111111111111';
const CALC = '22222222-2222-4222-8222-222222222222';

type Api = ReturnType<typeof installFakeApi>;

async function mount(
  setup?: (api: Api) => void,
  options: { startupError?: string | null; waitForLoad?: boolean } = {},
) {
  const api = installFakeApi(options);
  setup?.(api);
  const user = userEvent.setup();
  const { unmount } = render(
    <Providers>
      <LibraryScreen />
    </Providers>,
  );
  if (options.waitForLoad !== false) {
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    });
  }
  return { api, user, unmount };
}

const seed = ({ meetings, projects }: Api): void => {
  projects.list = [projectListItem(UNI, 'Universidad'), projectListItem(CALC, 'Calculo')];
  meetings.records.set('a', meetingRecord('a', 'Standup', '2026-09-01T09:00:00.0000000+00:00'));
  meetings.records.set(
    'c',
    meetingRecord('c', 'Review', '2026-09-02T09:00:00.0000000+00:00', { projectId: 'gone' }),
  );
};

function rowOf(name: RegExp): HTMLElement {
  return screen.getByRole('row', { name });
}

describe('loading', () => {
  it('the skeleton shows and the body is hidden during the first load', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount(
      (a) => {
        seed(a);
        const load = a.service.load.bind(a.service);
        vi.spyOn(a.service, 'load').mockImplementation(async () => {
          await gate;
          return load();
        });
      },
      { waitForLoad: false },
    );
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Standup')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Standup')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
});

describe('the meeting row', () => {
  it('right click and the more button both open Open summary, Move to project, Delete in that order', async () => {
    const { user } = await mount(seed);
    const names = (): (string | null)[] =>
      screen.getAllByRole('menuitem').map((item) => item.textContent);
    await user.pointer({
      keys: '[MouseRight]',
      target: rowOf(/Standup/),
    });
    await screen.findByRole('menuitem', { name: 'Move to project' });
    expect(names()).toEqual(['Open summary', 'Move to project', 'Delete']);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    });
    await user.click(within(rowOf(/Standup/)).getByRole('button', { name: 'More actions' }));
    await screen.findByRole('menuitem', { name: 'Move to project' });
    expect(names()).toEqual(['Open summary', 'Move to project', 'Delete']);
  });

  it('the row shows the local time, with the short date and time on hover', async () => {
    await mount(seed);
    const expected = formatMeetingDate('2026-09-01T09:00:00.0000000+00:00', 'en');
    expect(expected).not.toBe('');
    expect(within(rowOf(/Standup/)).getByTitle(expected)).toHaveTextContent(/^\d{2}:\d{2}$/);
  });
});

describe('status messages and startup', () => {
  it('the status notice has a Close that clears the message', async () => {
    const { api, user } = await mount(seed);
    api.meetings.lockedIds.add('c');
    await user.click(within(rowOf(/Review/)).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/The meeting was not deleted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/The meeting was not deleted/)).not.toBeInTheDocument();
  });

  it('a startup migration error is shown in the page', async () => {
    await mount(seed, { startupError: 'meetings.json is damaged' });
    expect(
      await screen.findByText(/could not be moved yet\. meetings\.json is damaged/),
    ).toBeInTheDocument();
  });
});
