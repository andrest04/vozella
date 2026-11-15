// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { EngineSetupDialog } from './EngineSetupDialog';
import { installTranscriptionApi } from './transcription-test-kit';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'vozella');
});

describe('EngineSetupDialog', () => {
  it('starts by itself, shows the step and the overall bar, and closes ready', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const api = installTranscriptionApi({
      'transcription.ensureEngine': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const onFinished = vi.fn();
    render(
      <Providers>
        <EngineSetupDialog open onFinished={onFinished} />
      </Providers>,
    );
    expect(await screen.findByText('Preparing download...')).toBeVisible();
    api.emit('transcription.installProgress', {
      stage: 'runtime-cpu',
      percent: 50,
      stepIndex: 0,
      stepCount: 2,
    });
    expect(await screen.findByText('Downloading the NVIDIA CPU runtime')).toBeVisible();
    expect(screen.getByText('Step 1 of 2')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    finish({ status: 'ready' });
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(true);
    });
  });

  it('offers the cloud as a secondary way out, which cancels the download and reports only that', async () => {
    const api = installTranscriptionApi({
      'transcription.ensureEngine': () => new Promise(() => undefined),
      'transcription.cancelInstall': () => ({ cancelled: true }),
    });
    const onFinished = vi.fn();
    const onUseCloud = vi.fn();
    render(
      <Providers>
        <EngineSetupDialog open onFinished={onFinished} onUseCloud={onUseCloud} />
      </Providers>,
    );
    expect(
      await screen.findByText(
        'No room for the download, or a slow computer? You can transcribe in the cloud with your own API key instead.',
      ),
    ).toBeVisible();
    const cloud = screen.getByRole('button', { name: 'Use the cloud instead' });
    // Cancel stays the one emphasized action; the alternative does not compete with it.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-ink');
    expect(cloud).not.toHaveClass('bg-ink');
    await userEvent.click(cloud);
    expect(onUseCloud).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(api.calls.filter((call) => call.name === 'transcription.cancelInstall')).toHaveLength(1);
    expect(api.calls.some((call) => call.name === 'settings.update')).toBe(false);
  });

  it('keeps the cloud way out next to a failed download', async () => {
    installTranscriptionApi({
      'transcription.ensureEngine': () => ({ status: 'failed', message: 'disk full' }),
    });
    render(
      <Providers>
        <EngineSetupDialog open onFinished={vi.fn()} onUseCloud={vi.fn()} />
      </Providers>,
    );
    expect(await screen.findByText('disk full')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use the cloud instead' })).toBeEnabled();
  });

  it('draws no cloud way out for a caller that cannot follow it', async () => {
    installTranscriptionApi({
      'transcription.ensureEngine': () => new Promise(() => undefined),
    });
    render(
      <Providers>
        <EngineSetupDialog open onFinished={vi.fn()} />
      </Providers>,
    );
    await screen.findByText('Preparing download...');
    expect(screen.queryByRole('button', { name: 'Use the cloud instead' })).toBeNull();
  });

  it('reports a cancel once, and a late cancelled answer cannot close a dialog opened again', async () => {
    const answers: ((value: unknown) => void)[] = [];
    installTranscriptionApi({
      'transcription.ensureEngine': () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    });
    const onFinished = vi.fn();
    const view = render(
      <Providers>
        <EngineSetupDialog open onFinished={onFinished} />
      </Providers>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenLastCalledWith(false);

    view.rerender(
      <Providers>
        <EngineSetupDialog open={false} onFinished={onFinished} />
      </Providers>,
    );
    view.rerender(
      <Providers>
        <EngineSetupDialog open onFinished={onFinished} />
      </Providers>,
    );
    await vi.waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    answers[0]?.({ status: 'cancelled' });
    answers[1]?.({ status: 'ready' });
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenLastCalledWith(true);
    });
    expect(onFinished).toHaveBeenCalledTimes(2);
  });
});
