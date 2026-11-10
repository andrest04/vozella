import path from 'node:path';
import type { CliPathProbe, HardwareProbe, SettingsStore } from '@vozella/core';
import {
  FakeCliProbe,
  FakeHardwareProbe,
  FileFakeCliProbe,
  FileLocalModelStore,
  PathCliProbe,
  SettingsRuntime,
  SystemHardwareProbe,
} from '@vozella/platform';
import type { Broadcast } from '../ipc/library-handlers';
import { modelEventBridge } from '../ipc/settings-handlers';
import {
  fakeModelScriptFromEnv,
  ScriptedFakeModelStore,
} from '../summaries/scripted-fake-model-store';

export interface ComposeSettingsDeps {
  readonly fakeNative: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly appDataDirectory: string;
  readonly store: SettingsStore;
  readonly osLanguages: () => readonly string[];
  readonly relaunch: () => void;
  readonly broadcast: Broadcast;
  /** Whether the llama runtime in use offloads to the GPU; unknown until summaries pick one. */
  readonly activeGpuOffload: () => boolean | undefined;
}

export interface ComposedSettings {
  readonly hardware: HardwareProbe;
  readonly summaryModels: FileLocalModelStore | ScriptedFakeModelStore;
  readonly summaryCli: CliPathProbe;
  readonly settings: SettingsRuntime;
}

/**
 * The machine probes (hardware, summary models, CLIs) and the Settings services. In the fake
 * native build the machine, the CLIs, the model downloads are doubles, so nothing touches the
 * network.
 */
export function composeSettings(deps: ComposeSettingsDeps): ComposedSettings {
  const { fakeNative, env } = deps;
  // One hardware read per process, shared by the Settings page and the transcription engine.
  const hardware: HardwareProbe = fakeNative
    ? new FakeHardwareProbe(
        env.VOZELLA_FAKE_NO_GPU === '1'
          ? { totalRamGb: 16, gpuName: null, gpuVramGb: null }
          : { totalRamGb: 16, gpuName: 'Fake GPU', gpuVramGb: 8 },
      )
    : new SystemHardwareProbe();

  // The model folder and the CLI probe are shared by the Settings page and the summary module.
  const summaryModels = fakeNative
    ? new ScriptedFakeModelStore(fakeModelScriptFromEnv(env))
    : new FileLocalModelStore({ directory: path.join(deps.appDataDirectory, 'SummaryModels') });
  // A test that sets VOZELLA_FAKE_CLI_FILES decides what is installed by putting files in
  // <app data>/fake-cli, so it can flip the answer while the app runs.
  const summaryCli = !fakeNative
    ? new PathCliProbe()
    : env.VOZELLA_FAKE_CLI_FILES === '1'
      ? new FileFakeCliProbe(path.join(deps.appDataDirectory, 'fake-cli'))
      : new FakeCliProbe(new Set(['claude']));

  const settings: SettingsRuntime = new SettingsRuntime({
    activeGpuOffload: deps.activeGpuOffload,
    store: deps.store,
    appDataDirectory: deps.appDataDirectory,
    osLanguages: deps.osLanguages,
    relaunch: deps.relaunch,
    notifyModel: modelEventBridge(deps.broadcast),
    hardware,
    cli: summaryCli,
    modelStore: summaryModels,
  });
  return { hardware, summaryModels, summaryCli, settings };
}
