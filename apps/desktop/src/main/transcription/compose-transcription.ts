import {
  resolveTemplateInstructions,
  type AsrEngine,
  type HardwareProbe,
  type Logger,
  type MeetingBusyRegistry,
  type PatchQueue,
  type TranslateFn,
  type Workspace,
} from '@vozella/core';
import {
  fakeAsrPhrasesFromEnv,
  fakeEngineOptionsFromEnv,
  FakeSpeechEngine,
  SteppedModelStore,
  SteppedRuntimeStore,
  TranscriptionRuntime,
  type LibraryRuntime,
  liveRepository,
} from '@vozella/platform';
import type { Broadcast } from '../ipc/library-handlers';
import type { IpcServerDeps } from '../ipc/ipc-server';
import { registerSessionHandlers } from '../ipc/session-handlers';
import { registerTranscriptionHandlers } from '../ipc/transcription-handlers';
import type { AudioPushEvent } from '../workers/audio-worker-host';
import {
  TranscriptionController,
  type TranscriptionControllerDeps,
} from './transcription-controller';

export interface ComposeTranscriptionDeps {
  readonly library: Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>;
  /** The real engine (the ASR worker); the fake native build uses its double instead. */
  readonly asr: AsrEngine;
  readonly fakeNative: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly hardware: HardwareProbe;
  /** The audio worker's push events; recording frames feed the live pass. */
  readonly audio: { onPush(listener: (event: AudioPushEvent) => void): () => void };
  readonly busy: MeetingBusyRegistry;
  readonly workspace: Workspace;
  readonly broadcast: Broadcast;
  /** Already scoped to the transcription (`logger.child('transcription')`). */
  readonly logger: Logger;
  readonly translate: TranslateFn;
  /** A zero-byte or unreadable recording is no audio (B20). */
  readonly fileExists: (file: string) => boolean;
  readonly queue: PatchQueue;
  /** Re-transcription also regenerates the summary (the recording module reuses the same hook). */
  readonly summarize: NonNullable<TranscriptionControllerDeps['summarize']>;
  readonly formatFailure: (error: unknown) => string;
  /** Explorer selects the file; Finder reveals it. */
  readonly reveal: (file: string) => void;
  readonly server: IpcServerDeps;
  readonly stopOnExit: (stop: () => void) => void;
}

/** The transcription module and the session page it serves, with their IPC handlers. */
export function composeTranscription(deps: ComposeTranscriptionDeps): TranscriptionController {
  const { library, workspace } = deps;
  // Transcription: the engine runs in its own process; the controller serves the pages and
  // gives the recording module the live pass and the offline pass.
  const transcription = new TranscriptionRuntime({
    transcriptionModelsDirectory: library.paths.transcriptionModelsDirectory,
    nemoSpeechDirectory: library.paths.nemoSpeechDirectory,
    engine: deps.fakeNative
      ? new FakeSpeechEngine(
          Math.max(0, Number(deps.env.VOZELLA_FAKE_ASR_OFFLINE_PUSH_MS) || 0),
          fakeAsrPhrasesFromEnv(deps.env),
        )
      : deps.asr,
    hardware: () => deps.hardware.detect(),
    logger: deps.logger,
    ...(deps.fakeNative
      ? {
          stores: (() => {
            const options = fakeEngineOptionsFromEnv(deps.env);
            return {
              models: new SteppedModelStore(options),
              runtimes: new SteppedRuntimeStore(options),
            };
          })(),
        }
      : {}),
  });
  const transcriptionController = new TranscriptionController({
    runtime: transcription,
    settings: library.settings,
    meetings: liveRepository(() => library.meetings),
    busy: deps.busy,
    broadcast: deps.broadcast,
    logger: deps.logger,
    t: deps.translate,
    onRecordingFrames: (listener) =>
      deps.audio.onPush((event) => {
        if (event.type === 'recording-frame') listener(event.pcm, event.levels);
      }),
    // Same rule as the session view: a zero-byte or unreadable recording is no audio (B20).
    fileExists: deps.fileExists,
    queue: deps.queue,
    isCaptureActive: () => workspace.state.isCaptureActive,
    onMeetingChanged: (id) => {
      workspace.notifyMeetingChanged(id);
    },
    summarize: deps.summarize,
    templateInstructions: (record) =>
      Promise.resolve(resolveTemplateInstructions(record.noteTemplateId)),
    formatFailure: deps.formatFailure,
  });
  registerTranscriptionHandlers({ server: deps.server, controller: transcriptionController });
  registerSessionHandlers({
    server: deps.server,
    meetings: liveRepository(() => library.meetings),
    workspace,
    runnerState: () => transcriptionController.retranscription,
    // A zero-byte or unreadable recording counts as no audio (B20).
    fileExists: deps.fileExists,
    // Explorer selects the file; Finder reveals it.
    reveal: { reveal: deps.reveal },
  });
  deps.stopOnExit(() => {
    transcriptionController.dispose();
  });
  return transcriptionController;
}
