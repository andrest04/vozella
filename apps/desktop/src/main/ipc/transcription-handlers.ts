import {
  retranscriptionAvailability,
  retranscriptionCancel,
  retranscriptionDismiss,
  retranscriptionGetState,
  retranscriptionStart,
  transcriptionCancelInstall,
  transcriptionClearProviderKey,
  transcriptionDeleteEngine,
  transcriptionDeleteSpeakerModel,
  transcriptionDownloadSpeakerModel,
  transcriptionEnsureEngine,
  transcriptionGetStatus,
  transcriptionSetLiveEnabled,
  transcriptionSetProviderKey,
  transcriptionSetSpeakerLabels,
  transcriptionVerifyProviderKey,
} from '@vozella/contracts';
import type { TranscriptionProviderKeys } from '@vozella/platform';
import type { TranscriptionController } from '../transcription/transcription-controller';
import { registerRequest, type IpcServerDeps } from './ipc-server';

export interface TranscriptionHandlerDeps {
  readonly server: IpcServerDeps;
  readonly controller: TranscriptionController;
  /** The key commands of the providers that only transcribe. */
  readonly providerKeys: Pick<TranscriptionProviderKeys, 'set' | 'clear' | 'verify'>;
}

/** Wires the transcription channels. One line per channel; the rules live in core. */
export function registerTranscriptionHandlers(deps: TranscriptionHandlerDeps): void {
  const { server, controller, providerKeys } = deps;

  registerRequest(server, transcriptionGetStatus, () => controller.status());
  registerRequest(server, transcriptionEnsureEngine, ({ local }) =>
    controller.ensureEngine(local === true ? { local: true } : {}),
  );
  registerRequest(server, transcriptionCancelInstall, () => ({
    cancelled: controller.cancelInstall(),
  }));
  registerRequest(server, transcriptionDeleteEngine, async () => ({
    outcome: await controller.deleteEngine(),
  }));
  registerRequest(server, transcriptionSetLiveEnabled, async ({ enabled }) => ({
    saved: await controller.setLiveEnabled(enabled),
  }));
  registerRequest(server, transcriptionSetSpeakerLabels, ({ enabled }) =>
    controller.setSpeakerLabels(enabled),
  );
  registerRequest(server, transcriptionDownloadSpeakerModel, () =>
    controller.downloadSpeakerModel(),
  );
  registerRequest(server, transcriptionDeleteSpeakerModel, () => controller.deleteSpeakerModel());
  // The key arrives once and goes straight into the encrypted store; answers carry only a flag.
  // A cloud engine is ready only with its key, so the status is published again after a change.
  registerRequest(server, transcriptionSetProviderKey, async ({ kind, key }) => {
    const result = await providerKeys.set(kind, key);
    void controller.refreshStatus();
    return result;
  });
  registerRequest(server, transcriptionClearProviderKey, async ({ kind }) => {
    const result = await providerKeys.clear(kind);
    void controller.refreshStatus();
    return result;
  });
  registerRequest(server, transcriptionVerifyProviderKey, ({ kind }) => providerKeys.verify(kind));
  registerRequest(server, retranscriptionAvailability, async ({ meetingId }) => ({
    availability: await controller.retranscriptionAvailability(meetingId),
  }));
  registerRequest(server, retranscriptionStart, ({ meetingId }) =>
    controller.startRetranscription(meetingId),
  );
  registerRequest(server, retranscriptionCancel, () => {
    controller.cancelRetranscription();
    return { cancelled: true as const };
  });
  registerRequest(server, retranscriptionGetState, () => controller.retranscriptionSnapshot());
  registerRequest(server, retranscriptionDismiss, ({ meetingId }) => {
    controller.dismissRetranscription(meetingId);
    return { dismissed: true as const };
  });
}
