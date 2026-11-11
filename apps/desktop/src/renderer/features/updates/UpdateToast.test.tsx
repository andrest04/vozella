// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@vozella/contracts';
import { Providers } from '../../app/test-providers';
import { REMIND_LATER_MS, UpdateToast, readyVersion } from './UpdateToast';

type Listener = (payload: unknown) => void;

const ready: UpdateState = {
  currentVersion: '0.9.7',
  update: { status: 'ready', version: '0.10.0' },
};
const idle: UpdateState = { currentVersion: '0.9.7', update: { status: 'idle' } };
const recording = (isRecording: boolean, isProcessing = false) => ({ isRecording, isProcessing });

/** This feature's own window.vozella: update state, recording state and the install request. */
function install(options: {
  state?: UpdateState;
  recording?: { isRecording: boolean; isProcessing: boolean };
  outcome?: unknown;
}) {
  const listeners = new Map<string, Set<Listener>>();
  const invoke = vi.fn((name: string) => {
    if (name === 'updates.getState') return Promise.resolve(options.state ?? idle);
    if (name === 'recording.getState')
      return Promise.resolve(options.recording ?? recording(false));
    if (name === 'updates.install')
      return Promise.resolve(options.outcome ?? { status: 'restarting' });
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
  const emit = (name: string, payload: unknown) => {
    act(() => {
      listeners.get(name)?.forEach((listener) => {
        listener(payload);
      });
    });
  };
  return { invoke, emit };
}

const mount = (locale: 'en' | 'es' = 'en') =>
  render(
    <Providers locale={locale}>
      <UpdateToast />
    </Providers>,
  );

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'vozella');
});

describe('readyVersion', () => {
  it('names the downloaded version only once it is ready', () => {
    expect(readyVersion(ready)).toBe('0.10.0');
    expect(readyVersion(idle)).toBeNull();
    expect(
      readyVersion({
        currentVersion: '1',
        update: { status: 'downloading', version: '2', percent: 40 },
      }),
    ).toBeNull();
    expect(readyVersion(null)).toBeNull();
  });
});

describe('UpdateToast', () => {
  it('shows nothing while no update is ready', async () => {
    const api = install({ state: idle });
    mount();
    await vi.waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('updates.getState', {});
    });
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
  });

  it('shows the title, both versions, the question and the two actions once ready', async () => {
    install({ state: ready });
    mount();
    const toast = await screen.findByRole('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.textContent).toContain('A new version of Vozella is available!');
    expect(toast.textContent).toContain('(0.9.7 → 0.10.0)');
    expect(toast.textContent).toContain('Would you like to install it now? Vozella will restart.');
    expect(screen.getByRole('button', { name: 'Remind me later' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('appears when main pushes a finished download', async () => {
    const api = install({ state: idle });
    mount();
    await vi.waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('updates.getState', {});
    });
    api.emit('updates.stateChanged', ready);
    expect(screen.getByTestId('UpdateToast')).toBeTruthy();
  });

  it('installs now through main', async () => {
    const api = install({ state: ready });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Install now' }));
    expect(api.invoke).toHaveBeenCalledWith('updates.install', {});
  });

  it('tells a failed install and stays usable', async () => {
    install({ state: ready, outcome: { status: 'failed', message: 'spawn' } });
    mount();
    const button = await screen.findByRole('button', { name: 'Install now' });
    await userEvent.click(button);
    expect(await screen.findByText(/The update could not start/)).toBeTruthy();
    expect(button.hasAttribute('disabled') || button.getAttribute('data-disabled') !== null).toBe(
      false,
    );
  });

  it.each([
    [
      'Remind me later',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Remind me later' })),
    ],
    [
      'close',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Close' })),
    ],
    [
      'Escape',
      async (user: ReturnType<typeof userEvent.setup>) => {
        screen.getByRole('button', { name: 'Install now' }).focus();
        await user.keyboard('{Escape}');
      },
    ],
  ])('hides on %s and comes back a few hours later', async (_name, hide) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    install({ state: ready });
    mount();
    await screen.findByTestId('UpdateToast');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    await hide(user);
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(REMIND_LATER_MS - 1000);
    });
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('UpdateToast')).toBeTruthy();
  });

  it('stays hidden while a recording runs and shows once it stops', async () => {
    const api = install({ state: ready, recording: recording(true) });
    mount();
    await vi.waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('recording.getState', {});
    });
    await act(() => Promise.resolve());
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
    api.emit('recording.state', recording(false, true));
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
    api.emit('recording.state', recording(false));
    expect(screen.getByTestId('UpdateToast')).toBeTruthy();
  });

  it('hides when a recording starts while it shows', async () => {
    const api = install({ state: ready });
    mount();
    await screen.findByTestId('UpdateToast');
    api.emit('recording.state', recording(true));
    expect(screen.queryByTestId('UpdateToast')).toBeNull();
  });

  it('reads in Spanish', async () => {
    install({ state: ready });
    mount('es');
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toContain('¡Hay una nueva versión de Vozella disponible!');
    expect(screen.getByRole('button', { name: 'Recordármelo más tarde' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Instalar ahora' })).toBeTruthy();
  });
});
