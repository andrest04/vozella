import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onTranscriptionFocus,
  openTranscriptionInSettings,
  pendingTranscriptionFocus,
  takeTranscriptionFocus,
} from './transcription-focus';

const invoke = vi.fn(() => Promise.resolve({}));

beforeEach(() => {
  invoke.mockClear();
  vi.stubGlobal('window', { vozella: { invoke } });
});

afterEach(() => {
  takeTranscriptionFocus();
  vi.unstubAllGlobals();
});

describe('a link to the Transcription section', () => {
  it('navigates to Settings and waits until the section takes it', () => {
    openTranscriptionInSettings('key');
    expect(invoke).toHaveBeenCalledWith('workspace.dispatch', {
      action: { type: 'navigateTo', tag: 'Settings' },
    });
    expect(takeTranscriptionFocus()).toBe('key');
    expect(takeTranscriptionFocus()).toBeNull();
  });

  it('can be looked at without using it up, so the page can pick the tab first', () => {
    expect(pendingTranscriptionFocus()).toBeNull();
    openTranscriptionInSettings('choice');
    expect(pendingTranscriptionFocus()).toBe('choice');
    expect(pendingTranscriptionFocus()).toBe('choice');
    expect(takeTranscriptionFocus()).toBe('choice');
    expect(pendingTranscriptionFocus()).toBeNull();
  });

  it('tells every listener while Settings is on screen, until it unsubscribes', () => {
    const page = vi.fn();
    const section = vi.fn();
    const offPage = onTranscriptionFocus(page);
    const offSection = onTranscriptionFocus(section);
    openTranscriptionInSettings('key');
    expect(page).toHaveBeenCalledWith('key');
    expect(section).toHaveBeenCalledWith('key');
    offPage();
    offSection();
    openTranscriptionInSettings('choice');
    expect(page).toHaveBeenCalledTimes(1);
  });
});
