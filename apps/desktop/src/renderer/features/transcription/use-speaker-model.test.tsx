// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { installTranscriptionApi } from './transcription-test-kit';
import { useSpeakerModel } from './use-speaker-model';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

const wrapper = ({ children }: { children: ReactNode }) => <Providers>{children}</Providers>;

const mountHook = () => {
  const refresh = vi.fn(() => Promise.resolve());
  const announce = vi.fn();
  const view = renderHook(() => useSpeakerModel({ refresh, announce }), { wrapper });
  return { ...view, refresh, announce };
};

/** A handler whose answer the test releases by hand. */
const held = () => {
  let release: (value: unknown) => void = () => undefined;
  const handler = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  return { handler, release: (value: unknown) => release(value) };
};

describe('useSpeakerModel', () => {
  it('follows only the speaker model progress while a download runs, then settles', async () => {
    const gate = held();
    const api = installTranscriptionApi({ 'transcription.downloadSpeakerModel': gate.handler });
    const { result, refresh } = mountHook();

    act(() => {
      result.current.download();
    });
    expect(result.current.busy).toBe('download');
    api.emit('transcription.installProgress', { stage: 'speaker-model', percent: 41.6 });
    expect(result.current.percent).toBe(42);
    api.emit('transcription.installProgress', { stage: 'model', percent: 90 });
    expect(result.current.percent).toBe(42);

    await act(async () => {
      gate.release({ status: 'ready' });
      await Promise.resolve();
    });
    expect(result.current.busy).toBeNull();
    expect(result.current.percent).toBe(0);
    expect(result.current.note).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('ignores progress when no speaker action runs', () => {
    const api = installTranscriptionApi();
    const { result } = mountHook();
    api.emit('transcription.installProgress', { stage: 'speaker-model', percent: 50 });
    expect(result.current.percent).toBe(0);
  });

  it('says a failed download keeps speaker labels off', async () => {
    installTranscriptionApi({
      'transcription.downloadSpeakerModel': () => ({ status: 'failed', message: 'offline' }),
    });
    const { result } = mountHook();
    await act(async () => {
      result.current.download();
      await Promise.resolve();
    });
    expect(result.current.note).toBe('Download failed: offline Speaker labels stay off.');
  });

  it('turns a thrown error into the same note', async () => {
    installTranscriptionApi({
      'transcription.downloadSpeakerModel': () => {
        throw new Error('gone');
      },
    });
    const { result } = mountHook();
    await act(async () => {
      result.current.download();
      await Promise.resolve();
    });
    expect(result.current.note).toBe('Download failed: gone Speaker labels stay off.');
  });

  it('announces a delete and reports a failed one', async () => {
    let answer: unknown = { status: 'ready' };
    const api = installTranscriptionApi({ 'transcription.deleteSpeakerModel': () => answer });
    const { result, announce } = mountHook();

    await act(async () => {
      result.current.remove();
      await Promise.resolve();
    });
    expect(api.calls.map((call) => call.name)).toContain('transcription.deleteSpeakerModel');
    expect(announce).toHaveBeenCalledWith('Speaker model deleted.');
    expect(result.current.note).toBeNull();

    answer = { status: 'failed', message: 'locked' };
    await act(async () => {
      result.current.remove();
      await Promise.resolve();
    });
    expect(result.current.note).toBe('Could not delete the speaker model: locked');
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('switching labels off counts as a delete, on as a download', async () => {
    const gate = held();
    const api = installTranscriptionApi({ 'transcription.setSpeakerLabels': gate.handler });
    const { result } = mountHook();

    act(() => {
      result.current.setLabels(false);
    });
    expect(result.current.busy).toBe('delete');
    expect(api.calls.at(-1)).toEqual({
      name: 'transcription.setSpeakerLabels',
      input: { enabled: false },
    });
    await act(async () => {
      gate.release({ status: 'failed', message: 'busy' });
      await Promise.resolve();
    });
    expect(result.current.note).toBe('Could not delete the speaker model: busy');

    act(() => {
      result.current.setLabels(true);
    });
    expect(result.current.busy).toBe('download');
    await act(async () => {
      gate.release({ status: 'ready' });
      await Promise.resolve();
    });
    expect(result.current.busy).toBeNull();
  });

  it('runs one action at a time', async () => {
    const gate = held();
    const api = installTranscriptionApi({ 'transcription.downloadSpeakerModel': gate.handler });
    const { result } = mountHook();

    act(() => {
      result.current.download();
    });
    act(() => {
      result.current.remove();
    });
    expect(api.calls.map((call) => call.name)).not.toContain('transcription.deleteSpeakerModel');
    await act(async () => {
      gate.release({ status: 'ready' });
      await Promise.resolve();
    });
  });
});
