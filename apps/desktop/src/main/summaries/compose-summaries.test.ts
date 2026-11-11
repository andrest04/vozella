import { MeetingBusyRegistry, Workspace, type SettingsStore } from '@vozella/core';
import { FakeApiKeyStore, type LibraryRuntime } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  noDialogs,
  recordingIpc,
  requestChannelsWithPrefix,
  silentLogger,
} from '../compose-test-kit';
import { composeSettings } from '../settings/compose-settings';
import { composeSummaries, type ComposeSummariesDeps } from './compose-summaries';

function compose(overrides: Partial<ComposeSummariesDeps> = {}) {
  const { server, channels } = recordingIpc();
  const machine = composeSettings({
    fakeNative: true,
    env: {},
    appDataDirectory: 'C:/app-data',
    store: {} as SettingsStore,
    osLanguages: () => [],
    relaunch: vi.fn(),
    broadcast: vi.fn(),
    activeGpuOffload: () => undefined,
  });
  const busy = new MeetingBusyRegistry();
  const stopOnExit = vi.fn();
  const onWillQuit = vi.fn();
  const publishGpuOffload = vi.fn();
  const loadProcessJob = vi.fn(() => undefined);
  const composed = composeSummaries({
    library: { meetings: {}, settings: {} } as unknown as Pick<
      LibraryRuntime,
      'meetings' | 'settings'
    >,
    hardware: machine.hardware,
    models: machine.summaryModels,
    cli: machine.summaryCli,
    apiKeys: new FakeApiKeyStore(),
    settingsModels: machine.settings.models,
    llamaRoot: 'C:/app-data/LlamaRuntime',
    fakeNative: true,
    env: {},
    loadProcessJob,
    publishGpuOffload,
    activeGpuOffload: () => undefined,
    busy,
    workspace: new Workspace(),
    broadcast: vi.fn(),
    logger: silentLogger(),
    translate: (key) => key,
    server,
    dialogs: noDialogs(),
    documentsDirectory: () => 'C:/Documents',
    writeClipboard: () => Promise.resolve(),
    stopOnExit,
    onWillQuit,
    ...overrides,
  });
  return { composed, channels, busy, stopOnExit, onWillQuit, publishGpuOffload, loadProcessJob };
}

describe('composeSummaries', () => {
  it('registers every summaries request channel once', () => {
    const { channels } = compose();
    expect([...channels].sort()).toEqual(requestChannelsWithPrefix('summaries.'));
  });

  it('hands the root the GPU offload reading of the runtime it built', () => {
    const { composed, publishGpuOffload } = compose();
    expect(publishGpuOffload).toHaveBeenCalledTimes(1);
    const read = publishGpuOffload.mock.calls[0]?.[0] as () => boolean | undefined;
    expect(read()).toBe(composed.runtime.host.gpuOffload);
  });

  it('stops the llama-server both on a real quit and on will-quit', () => {
    const { stopOnExit, onWillQuit } = compose();
    expect(stopOnExit).toHaveBeenCalledTimes(1);
    expect(onWillQuit).toHaveBeenCalledTimes(1);
  });

  it('reports a meeting being summarized as busy', () => {
    const { composed, busy } = compose();
    vi.spyOn(composed.service, 'isGenerating').mockImplementation((id) => id === 'm1');
    expect(busy.isBusy('m1')).toBe(true);
    expect(busy.isBusy('m2')).toBe(false);
  });

  it('asks for the native process job only outside the fake native build', () => {
    expect(compose().loadProcessJob).not.toHaveBeenCalled();
    expect(compose({ fakeNative: false }).loadProcessJob).toHaveBeenCalledTimes(1);
  });
});
