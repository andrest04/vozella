// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@vozella/contracts';
import { Providers } from '../../app/test-providers';
import { UpdatesRow } from './UpdatesRow';

type Listener = (payload: unknown) => void;

const CHECKED_AT = new Date(2026, 10, 22, 14, 5).getTime();
const state = (update: UpdateState['update'], lastCheckedAt?: number): UpdateState =>
  lastCheckedAt === undefined
    ? { currentVersion: '0.9.7', update }
    : { currentVersion: '0.9.7', update, lastCheckedAt };

/** The update state, the check and the install requests, and a way to push state changes. */
function install(
  options: { state?: UpdateState; check?: () => Promise<unknown>; install?: unknown } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  const invoke = vi.fn((name: string) => {
    if (name === 'updates.getState')
      return Promise.resolve(options.state ?? state({ status: 'idle' }));
    if (name === 'updates.check')
      return options.check ? options.check() : Promise.resolve({ status: 'started' });
    if (name === 'updates.install')
      return Promise.resolve(options.install ?? { status: 'restarting' });
    return Promise.reject(new Error(`unexpected ${name}`));
  });
  Object.defineProperty(window, 'vozella', {
    value: {
      invoke,
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>();
        listeners.set(name, set);
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
    },
    configurable: true,
    writable: true,
  });
  const emit = (payload: UpdateState) => {
    act(() => {
      listeners.get('updates.stateChanged')?.forEach((listener) => {
        listener(payload);
      });
    });
  };
  return { invoke, emit };
}

const mount = (locale: 'en' | 'es' = 'en') =>
  render(
    <Providers locale={locale}>
      <UpdatesRow />
    </Providers>,
  );

const row = () => screen.findByRole('group', { name: 'Updates' });
const message = () => screen.getByRole('status');
const checkButton = () => screen.getByRole('button', { name: 'Check for updates' });

describe('Settings updates row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 22, 16, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers a check and says updates are automatic before the first answer', async () => {
    install();
    mount();
    await row();
    await waitFor(() => {
      expect(message()).toHaveTextContent('Vozella checks for new versions every few hours.');
    });
    expect(checkButton()).toBeEnabled();
  });

  it('checks now, is disabled while checking, then says up to date with the time', async () => {
    let reply: (value: unknown) => void = () => undefined;
    const t = install({
      check: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    mount();
    await row();
    await userEvent.click(checkButton());
    expect(t.invoke).toHaveBeenCalledWith('updates.check', {});
    expect(checkButton()).toBeDisabled();
    expect(message()).toHaveTextContent('Checking for updates…');
    t.emit(state({ status: 'checking' }));
    await act(async () => {
      reply({ status: 'started' });
      await Promise.resolve();
    });
    expect(checkButton()).toBeDisabled();
    expect(message()).toHaveTextContent('Checking for updates…');
    t.emit(state({ status: 'idle' }, CHECKED_AT));
    expect(message()).toHaveTextContent('Up to date. Last checked 14:05.');
    expect(checkButton()).toBeEnabled();
  });

  it('names the day of an older check', async () => {
    install({ state: state({ status: 'idle' }, new Date(2026, 10, 20, 9, 0).getTime()) });
    mount();
    await waitFor(() => {
      expect(message()).toHaveTextContent('Up to date. Last checked 20 Nov, 09:00.');
    });
  });

  it('follows a found update and its download with the button disabled', async () => {
    const t = install();
    mount();
    await row();
    t.emit(state({ status: 'available', version: '0.10.0' }, CHECKED_AT));
    expect(message()).toHaveTextContent('Version 0.10.0 found. Downloading…');
    expect(checkButton()).toBeDisabled();
    t.emit(state({ status: 'downloading', version: '0.10.0', percent: 42 }, CHECKED_AT));
    expect(message()).toHaveTextContent('Downloading version 0.10.0: 42%');
    expect(checkButton()).toBeDisabled();
  });

  it('offers the install of a downloaded update instead of a new check', async () => {
    const t = install({ state: state({ status: 'ready', version: '0.10.0' }) });
    mount();
    const group = await row();
    await waitFor(() => {
      expect(message()).toHaveTextContent(
        'Version 0.10.0 is ready. Vozella restarts to install it.',
      );
    });
    expect(within(group).queryByRole('button', { name: 'Check for updates' })).toBeNull();
    await userEvent.click(within(group).getByRole('button', { name: 'Install now' }));
    expect(t.invoke).toHaveBeenCalledWith('updates.install', {});
  });

  it('says when the installer would not start', async () => {
    install({
      state: state({ status: 'ready', version: '0.10.0' }),
      install: { status: 'failed', message: 'spawn failed' },
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Install now' }));
    await waitFor(() => {
      expect(message()).toHaveTextContent(
        'The update could not start. It will install the next time you quit Vozella.',
      );
    });
    expect(screen.getByRole('button', { name: 'Install now' })).toBeEnabled();
  });

  it('explains a failed check and lets the user try again', async () => {
    const t = install({ state: state({ status: 'error', message: 'net::ERR' }) });
    mount();
    await waitFor(() => {
      expect(message()).toHaveTextContent(
        'The last check failed. Check your internet connection and try again.',
      );
    });
    expect(message()).not.toHaveTextContent('net::ERR');
    await userEvent.click(checkButton());
    expect(t.invoke).toHaveBeenCalledWith('updates.check', {});
  });

  it('says when this build does not update itself', async () => {
    install({ check: () => Promise.resolve({ status: 'disabled' }) });
    mount();
    await row();
    await userEvent.click(checkButton());
    await waitFor(() => {
      expect(message()).toHaveTextContent(
        'Updates are off in this build. Installed releases update themselves.',
      );
    });
    expect(checkButton()).toBeEnabled();
  });

  it('says the check failed when main does not answer', async () => {
    install({ check: () => Promise.reject(new Error('gone')) });
    mount();
    await row();
    await userEvent.click(checkButton());
    await waitFor(() => {
      expect(message()).toHaveTextContent('The last check failed.');
    });
    expect(checkButton()).toBeEnabled();
  });

  it('speaks Spanish', async () => {
    install({ state: state({ status: 'idle' }, CHECKED_AT) });
    mount('es');
    const group = await screen.findByRole('group', { name: 'Actualizaciones' });
    await waitFor(() => {
      expect(message()).toHaveTextContent('Está al día. Última comprobación: 14:05.');
    });
    expect(within(group).getByRole('button', { name: 'Buscar actualizaciones' })).toBeEnabled();
  });
});
