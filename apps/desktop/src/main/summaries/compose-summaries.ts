import path from 'node:path';
import { libraryChanged } from '@vozella/contracts';
import {
  API_ENGINES,
  CLI_ENGINES,
  isApiProvider,
  isCliProvider,
  PatchQueue,
  SummaryTabService,
  type ApiKeyStore,
  type CliPathProbe,
  type HardwareProbe,
  type Logger,
  type MeetingBusyRegistry,
  type TranslateFn,
  type Workspace,
} from '@vozella/core';
import {
  fakeSummaryOptionsFromEnv,
  FakeSummaryProvider,
  SummaryRuntime,
  SystemClock,
  writeFileAtomic,
  type LibraryRuntime,
  type SettingsRuntime,
} from '@vozella/platform';
import { mainCatalogs } from '../i18n/main-catalogs';
import type { Broadcast } from '../ipc/library-handlers';
import type { IpcServerDeps } from '../ipc/ipc-server';
import { registerSummariesHandlers, type SummariesHandlerDeps } from '../ipc/summaries-handlers';
import type { WindowDialogs } from '../window-dialogs';
import { ObservedSummaryService } from './observed-summary-service';
import { SummariesController } from './summaries-controller';

type SummaryRuntimeDeps = ConstructorParameters<typeof SummaryRuntime>[0];

export interface ComposeSummariesDeps {
  readonly library: Pick<LibraryRuntime, 'meetings' | 'settings'>;
  readonly hardware: HardwareProbe;
  readonly models: SummaryRuntimeDeps['models'];
  readonly cli: CliPathProbe;
  /** The app's one API key store (BYOK): readiness and the HTTP providers read keys from it. */
  readonly apiKeys: ApiKeyStore;
  /** The Settings page's model downloads, shared with the summaries page. */
  readonly settingsModels: SettingsRuntime['models'];
  /** `<app data>\LlamaRuntime`. */
  readonly llamaRoot: string;
  readonly fakeNative: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** Only asked for outside the fake native build. */
  readonly loadProcessJob: () => SummaryRuntimeDeps['processJob'];
  /** Hands the root the runtime's GPU offload reading as soon as the runtime exists. */
  readonly publishGpuOffload: (read: () => boolean | undefined) => void;
  readonly activeGpuOffload: () => boolean | undefined;
  readonly busy: MeetingBusyRegistry;
  readonly workspace: Workspace;
  readonly broadcast: Broadcast;
  /** Already scoped to the summaries (`logger.child('summaries')`). */
  readonly logger: Logger;
  readonly translate: TranslateFn;
  readonly server: IpcServerDeps;
  readonly dialogs: WindowDialogs;
  readonly documentsDirectory: () => string;
  readonly writeClipboard: SummariesHandlerDeps['writeClipboard'];
  readonly stopOnExit: (stop: () => void) => void;
  readonly onWillQuit: (run: () => void) => void;
}

export interface ComposedSummaries {
  readonly runtime: SummaryRuntime;
  /** The API key store the runtime reads, for the Settings key channels. */
  readonly apiKeys: ApiKeyStore;
  /** Shared with transcription: summary and transcript patches to one meeting never race. */
  readonly patchQueue: PatchQueue;
  readonly service: ObservedSummaryService;
  readonly controller: SummariesController;
}

/** The summaries module: runtime, service, controller and its IPC handlers. */
export function composeSummaries(deps: ComposeSummariesDeps): ComposedSummaries {
  const { library, workspace, broadcast } = deps;
  // Summaries: one runtime owns the providers and the single local llama-server. The fake
  // native build answers every engine with a double, so e2e needs no model or CLI.
  const summaryRuntime = new SummaryRuntime({
    settings: library.settings,
    hardware: deps.hardware,
    models: deps.models,
    llamaRoot: deps.llamaRoot,
    cli: deps.cli,
    apiKeys: deps.apiKeys,
    ...(deps.fakeNative
      ? {
          providerOverride: (kind) =>
            new FakeSummaryProvider(
              isCliProvider(kind)
                ? CLI_ENGINES[kind].providerId
                : isApiProvider(kind)
                  ? API_ENGINES[kind].providerId
                  : 'local',
              fakeSummaryOptionsFromEnv(deps.env),
            ),
        }
      : { processJob: deps.loadProcessJob() }),
  });
  deps.publishGpuOffload(() => summaryRuntime.host.gpuOffload);
  const summaryPatchQueue = new PatchQueue();
  const summaryService = new ObservedSummaryService(
    {
      queue: summaryPatchQueue,
      meetings: library.meetings,
      settings: library.settings,
      nextSessionDates: library.settings,
      resolver: summaryRuntime.resolver,
      clock: new SystemClock(),
      notifyMeetingChanged: (id) => {
        workspace.notifyMeetingChanged(id);
      },
      busy: deps.busy,
      placeholderFormats: [mainCatalogs.en, mainCatalogs.es].flatMap((catalog) => {
        const format = catalog.MeetingTitleFormat;
        return format === undefined ? [] : [format];
      }),
    },
    () => {
      broadcast(libraryChanged, { reason: 'meeting' });
    },
  );
  // A meeting being summarized cannot be re-transcribed, deleted or moved from under the run.
  deps.busy.register({ isBusy: (id) => summaryService.isGenerating(id) });
  const summaries = new SummariesController({
    service: summaryService,
    tab: new SummaryTabService({
      queue: summaryPatchQueue,
      meetings: library.meetings,
      translate: deps.translate,
      getSelectedMeetingId: () => workspace.state.selectedMeetingId,
      selectMeeting: (id) => {
        workspace.selectMeeting(id);
      },
      nextSessionDates: library.settings,
    }),
    resolver: summaryRuntime.resolver,
    models: deps.settingsModels,
    hardware: deps.hardware,
    cli: deps.cli,
    settings: library.settings,
    runtime: summaryRuntime,
    activeGpuOffload: deps.activeGpuOffload,
    broadcast,
    logger: deps.logger,
    t: deps.translate,
    // Action item deadlines: the `.ics` export goes where the user picks, Documents by default.
    pickIcsExportPath: async (defaultFileName) => {
      const result = await deps.dialogs.showSaveDialog({
        defaultPath: path.join(deps.documentsDirectory(), defaultFileName),
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    writeTextFile: (file, text) => writeFileAtomic(file, text),
  });
  registerSummariesHandlers({
    server: deps.server,
    controller: summaries,
    writeClipboard: deps.writeClipboard,
  });
  // No llama-server may outlive the app: kill it now, then let it end cleanly.
  deps.stopOnExit(() => {
    void summaries.dispose();
  });
  deps.onWillQuit(() => {
    void summaries.dispose();
  });
  return {
    runtime: summaryRuntime,
    apiKeys: deps.apiKeys,
    patchQueue: summaryPatchQueue,
    service: summaryService,
    controller: summaries,
  };
}
