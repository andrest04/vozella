import type { RecordingMessageDto } from '@vozella/contracts';
import type { CaptureNotice, Message } from '@vozella/core';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A status entry with its severity: from the notice itself, else from the catalog key. */
export function typed(message: Message | CaptureNotice): RecordingMessageDto {
  const severity =
    'severity' in message
      ? message.severity
      : message.key.startsWith('Error_') ||
          message.key.startsWith('Ui_Error') ||
          message.key === 'Ui_ProcessLoopbackUnsupported' ||
          message.key === 'Ui_TranscriptionEngineUnavailable'
        ? 'error'
        : message.key === 'Ui_SummaryProviderXaiRemoved'
          ? 'warning'
          : 'info';
  return { key: message.key, args: [...message.args], severity };
}
