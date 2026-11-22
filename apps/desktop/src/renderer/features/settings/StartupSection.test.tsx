// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { StartupSection } from './StartupSection';

interface Answers {
  readonly saved?: Record<string, unknown>;
  readonly getFails?: boolean;
  readonly updateFails?: boolean;
}

function install({ saved = { openAtLogin: false }, getFails, updateFails }: Answers = {}) {
  let current = { ...saved };
  const invoke = vi.fn((name: string, input: { patch?: Record<string, unknown> }) => {
    if (name === 'settings.get') {
      return getFails ? Promise.reject(new Error('read failed')) : Promise.resolve(current);
    }
    if (name === 'settings.update') {
      if (updateFails) return Promise.reject(new Error('write failed'));
      current = { ...current, ...input.patch };
      return Promise.resolve(current);
    }
    return Promise.reject(new Error(`unhandled ${name}`));
  });
  Object.defineProperty(window, 'vozella', {
    value: { invoke, on: () => () => undefined },
    configurable: true,
    writable: true,
  });
  return { invoke };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const mount = (locale: 'en' | 'es' = 'en') =>
  render(
    <Providers locale={locale}>
      <StartupSection />
    </Providers>,
  );

const toggle = () => screen.getByRole('switch', { name: 'Open Vozella when Windows starts' });

describe('StartupSection', () => {
  it('names the toggle and says the app opens in the tray', async () => {
    install();
    mount();
    expect(screen.getByRole('heading', { name: 'Startup' })).toBeTruthy();
    expect(
      screen.getByText(
        'It opens in the tray, without a window, so call detection is ready when a meeting starts.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('shows the saved value without writing it back', async () => {
    const { invoke } = install({ saved: { openAtLogin: true } });
    mount();
    await waitFor(() => {
      expect(toggle()).not.toHaveAttribute('aria-disabled', 'true');
    });
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['settings.get']);
  });

  it('turning it on and off patches only that field', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(toggle()).not.toHaveAttribute('aria-disabled', 'true');
    });
    await userEvent.click(toggle());
    expect(invoke).toHaveBeenCalledWith('settings.update', { patch: { openAtLogin: true } });
    await waitFor(() => {
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
    });
    await userEvent.click(toggle());
    expect(invoke).toHaveBeenLastCalledWith('settings.update', { patch: { openAtLogin: false } });
    await waitFor(() => {
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('a failed save goes back to the saved value', async () => {
    install({ saved: { openAtLogin: true }, updateFails: true });
    mount();
    await waitFor(() => {
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
    });
    await userEvent.click(toggle());
    await waitFor(() => {
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('stays disabled while the settings cannot be read', async () => {
    const { invoke } = install({ getFails: true });
    mount();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('settings.get', {});
    });
    expect(toggle()).toHaveAttribute('aria-disabled', 'true');
  });

  it('reads in Spanish', () => {
    install();
    mount('es');
    expect(screen.getByRole('heading', { name: 'Inicio' })).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Abrir Vozella al iniciar Windows' }),
    ).toBeInTheDocument();
  });
});
