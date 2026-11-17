// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { CustomTemplateSection } from './CustomTemplateSection';

function install(saved: { customNoteTemplate: string | null }) {
  const invoke = vi.fn((name: string, input: { patch?: { customNoteTemplate: string | null } }) => {
    if (name === 'settings.get') return Promise.resolve(saved);
    if (name === 'settings.update') return Promise.resolve({ ...saved, ...input.patch });
    return Promise.reject(new Error(name));
  });
  Object.defineProperty(window, 'vozella', {
    value: { invoke, on: () => () => undefined },
    configurable: true,
    writable: true,
  });
  return invoke;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const mount = () =>
  render(
    <Providers>
      <CustomTemplateSection />
    </Providers>,
  );

const field = () => screen.getByRole('textbox', { name: 'Custom template instructions' });

describe('CustomTemplateSection', () => {
  it('shows the saved text and keeps Save disabled until it changes', async () => {
    install({ customNoteTemplate: 'Use Goals and Risks' });
    mount();
    await waitFor(() => {
      expect((field() as HTMLTextAreaElement).value).toBe('Use Goals and Risks');
    });
    expect(screen.getByText('Custom note template')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save template' }).disabled).toBe(
      true,
    );
  });

  it('saves only this field, trimmed', async () => {
    const invoke = install({ customNoteTemplate: null });
    mount();
    await waitFor(() => {
      expect((field() as HTMLTextAreaElement).disabled).toBe(false);
    });
    await userEvent.type(field(), '  Goals then Risks  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('settings.update', {
        patch: { customNoteTemplate: 'Goals then Risks' },
      });
    });
    expect(await screen.findByText('Template saved')).toBeTruthy();
  });

  it('saving a blank text removes the template', async () => {
    const invoke = install({ customNoteTemplate: 'old' });
    mount();
    await waitFor(() => {
      expect((field() as HTMLTextAreaElement).value).toBe('old');
    });
    await userEvent.clear(field());
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('settings.update', {
        patch: { customNoteTemplate: null },
      });
    });
  });
});
