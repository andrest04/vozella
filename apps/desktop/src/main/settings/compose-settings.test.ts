import type { SettingsStore } from '@vozella/core';
import {
  FakeCliProbe,
  FakeHardwareProbe,
  FileFakeCliProbe,
  FileLocalModelStore,
  PathCliProbe,
  SystemHardwareProbe,
} from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedFakeModelStore } from '../summaries/scripted-fake-model-store';
import { composeSettings, type ComposeSettingsDeps } from './compose-settings';

const deps = (overrides: Partial<ComposeSettingsDeps>): ComposeSettingsDeps => ({
  fakeNative: true,
  env: {},
  appDataDirectory: 'C:/app-data',
  store: {} as SettingsStore,
  osLanguages: () => ['en-US'],
  relaunch: vi.fn(),
  broadcast: vi.fn(),
  activeGpuOffload: () => undefined,
  ...overrides,
});

describe('composeSettings', () => {
  it('uses the doubles in the fake native build, so nothing touches the machine', async () => {
    const composed = composeSettings(deps({ fakeNative: true }));
    expect(composed.hardware).toBeInstanceOf(FakeHardwareProbe);
    expect(composed.summaryModels).toBeInstanceOf(ScriptedFakeModelStore);
    expect(composed.summaryCli).toBeInstanceOf(FakeCliProbe);
    expect((await composed.hardware.detect()).gpuName).toBe('Fake GPU');
  });

  it('lets a test pick the installed CLIs from files and hide the GPU', async () => {
    const composed = composeSettings(
      deps({ env: { VOZELLA_FAKE_CLI_FILES: '1', VOZELLA_FAKE_NO_GPU: '1' } }),
    );
    expect(composed.summaryCli).toBeInstanceOf(FileFakeCliProbe);
    expect((await composed.hardware.detect()).gpuName).toBeNull();
  });

  it('uses the real probes outside the fake native build', () => {
    const composed = composeSettings(deps({ fakeNative: false }));
    expect(composed.hardware).toBeInstanceOf(SystemHardwareProbe);
    expect(composed.summaryModels).toBeInstanceOf(FileLocalModelStore);
    expect(composed.summaryCli).toBeInstanceOf(PathCliProbe);
  });

  it('shares one model store between the Settings page and the summaries', () => {
    const composed = composeSettings(deps({}));
    expect(composed.settings.models).toBeDefined();
    expect(composed.settings.exitGates).toBeDefined();
  });
});
