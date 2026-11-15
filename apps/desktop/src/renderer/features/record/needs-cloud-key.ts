import type { RecordingSetupDto } from '@vozella/contracts';

/**
 * True when the engine card is a cloud transcription engine waiting for its API key. Nothing can
 * be downloaded for it: the way forward is the key field in Settings. `detail.args[0]` is the
 * provider's name.
 */
export const needsCloudKey = (setup: RecordingSetupDto): boolean =>
  !setup.engine.ready && setup.engine.reason === 'key-missing';
