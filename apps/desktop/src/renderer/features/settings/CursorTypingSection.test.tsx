// @vitest-environment jsdom
import type { CursorTypingStatusDto } from '@vozella/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { CursorTypingSection } from './CursorTypingSection';

interface Saved {
  cursorTypingEnabled: boolean;
  cursorTypingShortcut: string | null;
  cursorTypingSource: string | null;
}

type Listener = (payload: CursorTypingStatusDto) => void;

const status = (over: Partial<CursorTypingStatusDto> = {}): CursorTypingStatusDto => ({
  state: { status: 'off' },
  shortcut: { status: 'inactive', accelerator: 'CommandOrControl+Alt+Space' },
  lastRefusal: null,
  ...over,
});

function install(initial: Partial<Saved> = {}, first: CursorTypingStatusDto = status()) {
  let saved: Saved = {
    cursorTypingEnabled: true,
    cursorTypingShortcut: null,
    cursorTypingSource: null,
    ...initial,
  };
  const listeners = new Set<Listener>();
  const invoke = vi.fn((name: string, input: { patch?: Partial<Saved> }) => {
    if (name === 'settings.get') return Promise.resolve(saved);
    if (name === 'settings.update') {
      saved = { ...saved, ...input.patch };
      return Promise.resolve(saved);
    }
    if (name === 'cursorTyping.getState') return Promise.resolve(first);
    return Promise.reject(new Error(name));
  });
  Object.defineProperty(window, 'vozella', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: (name: string, listener: Listener) => {
        if (name !== 'cursorTyping.state') return () => undefined;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    invoke,
    emit: (payload: CursorTypingStatusDto) => {
      act(() => {
        for (const listener of listeners) listener(payload);
      });
    },
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const mount = () =>
  render(
    <Providers>
      <CursorTypingSection />
    </Providers>,
  );

const toggle = () => screen.getByRole('switch', { name: 'Type what they say into any app' });
const shortcutButton = () => screen.getByRole('button', { name: /^Change shortcut, now/ });
const sourceSelect = () => screen.getByRole('combobox', { name: 'What to type' });
const updates = (invoke: ReturnType<typeof install>['invoke']) =>
  invoke.mock.calls.filter(([name]) => name === 'settings.update').map(([, input]) => input);

describe('CursorTypingSection', () => {
  it('shows the saved values and explains the feature without writing anything', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(toggle()).toBeChecked();
    });
    expect(shortcutButton()).toHaveAccessibleName('Change shortcut, now Ctrl+Alt+Space');
    expect(sourceSelect().textContent).toContain('Only the other participants');
    expect(screen.getByText(/press the shortcut/)).toBeTruthy();
    expect(screen.getByText("Apps running as administrator can't receive the text.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
    expect(updates(invoke)).toEqual([]);
  });

  it('saves the switch and disables the other rows when it is off', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(toggle()).toBeChecked();
    });
    await userEvent.click(toggle());
    await waitFor(() => {
      expect(updates(invoke)).toEqual([{ patch: { cursorTypingEnabled: false } }]);
    });
    await waitFor(() => {
      expect(toggle()).not.toBeChecked();
    });
    expect(shortcutButton()).toBeDisabled();
  });

  it('saves the source choice', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(sourceSelect().textContent).toContain('Only the other participants');
    });
    await userEvent.click(sourceSelect());
    await userEvent.click(await screen.findByRole('option', { name: 'Everything' }));
    await waitFor(() => {
      expect(updates(invoke)).toEqual([{ patch: { cursorTypingSource: 'all' } }]);
    });
    await waitFor(() => {
      expect(sourceSelect().textContent).toContain('Everything');
    });
  });

  it('captures a new combination, saves it and offers the default back', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(shortcutButton()).toBeEnabled();
    });
    await userEvent.click(shortcutButton());
    const capture = screen.getByRole('textbox', { name: /^New shortcut/ });
    expect(capture).toHaveFocus();
    await userEvent.keyboard('{Control>}{Shift>}[KeyK]{/Shift}{/Control}');
    await waitFor(() => {
      expect(updates(invoke)).toEqual([
        { patch: { cursorTypingShortcut: 'CommandOrControl+Shift+K' } },
      ]);
    });
    await waitFor(() => {
      expect(shortcutButton()).toHaveAccessibleName('Change shortcut, now Ctrl+Shift+K');
    });
    expect(shortcutButton()).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => {
      expect(updates(invoke)).toContainEqual({ patch: { cursorTypingShortcut: null } });
    });
    await waitFor(() => {
      expect(shortcutButton()).toHaveAccessibleName('Change shortcut, now Ctrl+Alt+Space');
    });
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
  });

  it('refuses a key without a modifier and keeps listening; Escape cancels', async () => {
    const { invoke } = install();
    mount();
    await waitFor(() => {
      expect(shortcutButton()).toBeEnabled();
    });
    await userEvent.click(shortcutButton());
    await userEvent.keyboard('[KeyA]');
    expect(screen.getByText('Add Ctrl, Alt or Win to the key.')).toBeTruthy();
    const capture = screen.getByRole('textbox', { name: /^New shortcut/ });
    expect(capture).toHaveAttribute('aria-invalid', 'true');
    expect(capture).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: /^New shortcut/ })).toBeNull();
    expect(shortcutButton()).toHaveFocus();
    expect(screen.queryByText('Add Ctrl, Alt or Win to the key.')).toBeNull();
    expect(updates(invoke)).toEqual([]);
  });

  it('says when another app holds the shortcut', async () => {
    const { emit } = install();
    mount();
    await waitFor(() => {
      expect(shortcutButton()).toBeEnabled();
    });
    expect(screen.queryByText(/Another app is using/)).toBeNull();
    emit(
      status({ shortcut: { status: 'unavailable', accelerator: 'CommandOrControl+Alt+Space' } }),
    );
    expect(
      screen.getByText('Another app is using Ctrl+Alt+Space. Choose a different shortcut.'),
    ).toBeTruthy();
  });
});
