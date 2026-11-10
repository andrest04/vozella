// @vitest-environment jsdom
import type { InstallOutcomeDto } from '@vozella/contracts';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../library/library-test-kit';
import { installTranscriptionApi } from './transcription-test-kit';
import { useEngineActions } from './use-engine-actions';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const wrapper = ({ children }: { children: ReactNode }) => <Providers>{children}</Providers>;

const mountHook = (outcome: InstallOutcomeDto = { status: 'ready' }) => {
  const start = vi.fn(() => Promise.resolve(outcome));
  const refresh = vi.fn(() => Promise.resolve());
  const announce = vi.fn();
  const view = renderHook(() => useEngineActions({ start, refresh, announce }), { wrapper });
  return { ...view, start, refresh, announce };
};

describe('useEngineActions', () => {
  it('downloads through the shared install and notes a failure', async () => {
    installTranscriptionApi();
    const { result, start, refresh } = mountHook({ status: 'failed', message: 'no disk' });
    await act(async () => {
      await result.current.download();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(result.current.note).toBe('Download failed: no disk');
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps no note after a good download', async () => {
    installTranscriptionApi();
    const { result } = mountHook();
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.note).toBeNull();
  });

  it('announces a clean delete', async () => {
    const api = installTranscriptionApi({
      'transcription.deleteEngine': () => ({ outcome: 'Deleted' }),
    });
    const { result, announce, refresh } = mountHook();
    await act(async () => {
      await result.current.remove();
    });
    expect(api.calls.map((call) => call.name)).toContain('transcription.deleteEngine');
    expect(announce).toHaveBeenCalledWith('Transcription engine deleted.');
    expect(result.current.note).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ['RuntimeInUse', 'The engine is in use. Restart the app, then delete it.'],
    ['Incomplete', 'Part of the engine could not be removed. It may need to be downloaded again.'],
  ])('says why a %s delete did not finish', async (outcome, note) => {
    installTranscriptionApi({ 'transcription.deleteEngine': () => ({ outcome }) });
    const { result, announce } = mountHook();
    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.note).toBe(note);
    expect(announce).not.toHaveBeenCalled();
  });

  it('notes a delete that throws', async () => {
    installTranscriptionApi({
      'transcription.deleteEngine': () => {
        throw new Error('ipc down');
      },
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.note).toBe('Download failed: ipc down');
  });

  it('sets live captions and refreshes even when the call fails', async () => {
    const api = installTranscriptionApi({
      'transcription.setLiveEnabled': () => Promise.reject(new Error('nope')),
    });
    const { result, refresh } = mountHook();
    await act(async () => {
      result.current.setLive(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.calls.at(-1)).toEqual({
      name: 'transcription.setLiveEnabled',
      input: { enabled: false },
    });
    expect(refresh).toHaveBeenCalled();
  });
});
