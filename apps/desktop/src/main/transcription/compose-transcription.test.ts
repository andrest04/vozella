import os from 'node:os';
import path from 'node:path';
import {
  MeetingBusyRegistry,
  PatchQueue,
  Workspace,
  type AsrEngine,
  type HardwareProbe,
} from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import { recordingIpc, requestChannelsWithPrefix, silentLogger } from '../compose-test-kit';
import { composeTranscription, type ComposeTranscriptionDeps } from './compose-transcription';

function compose(overrides: Partial<ComposeTranscriptionDeps> = {}) {
  const { server, channels } = recordingIpc();
  const root = path.join(os.tmpdir(), 'vozella-compose-transcription-test');
  const stopOnExit = vi.fn();
  const unsubscribe = vi.fn();
  const audio = { onPush: vi.fn(() => unsubscribe) };
  const controller = composeTranscription({
    library: {
      paths: {
        transcriptionModelsDirectory: path.join(root, 'models'),
        nemoSpeechDirectory: path.join(root, 'nemo'),
      },
      settings: {},
      meetings: {},
    } as unknown as Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>,
    asr: {} as AsrEngine,
    fakeNative: true,
    env: {},
    hardware: { detect: () => Promise.resolve({ gpuName: null }) } as unknown as HardwareProbe,
    audio,
    busy: new MeetingBusyRegistry(),
    workspace: new Workspace(),
    broadcast: vi.fn(),
    logger: silentLogger(),
    translate: (key) => key,
    fileExists: () => true,
    queue: new PatchQueue(),
    summarize: () => Promise.resolve({ status: 'skipped' }),
    formatFailure: String,
    reveal: vi.fn(),
    server,
    stopOnExit,
    ...overrides,
  });
  return { controller, channels, stopOnExit, audio };
}

describe('composeTranscription', () => {
  it('registers the transcription, re-transcription and session request channels once', () => {
    const { channels } = compose();
    expect([...channels].sort()).toEqual(
      requestChannelsWithPrefix('transcription.', 'retranscription.', 'session.'),
    );
  });

  it('reads meetings from the current Library folder after it changes', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const server = {
      ipc: {
        handle: (name: string, handler: (event: unknown, input: unknown) => unknown) => {
          handlers.set(name, handler);
        },
      },
      logger: silentLogger(),
      isTrusted: () => true,
    };
    const before = { get: vi.fn(() => Promise.resolve(null)) };
    const after = { get: vi.fn(() => Promise.resolve(null)) };
    let current: unknown = before;
    const library = {
      paths: { transcriptionModelsDirectory: 'models', nemoSpeechDirectory: 'nemo' },
      settings: {},
      get meetings() {
        return current;
      },
    } as unknown as Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>;
    compose({ library, server: server as unknown as ComposeTranscriptionDeps['server'] });
    current = after;
    const getView = handlers.get('session.getView');
    if (!getView) throw new Error('session.getView is not registered');
    await getView({ senderFrame: null }, { id: 'm1' });
    expect(after.get).toHaveBeenCalledWith('m1');
    expect(before.get).not.toHaveBeenCalled();
  });

  it('disposes the controller on a real quit', () => {
    const { controller, stopOnExit } = compose();
    expect(stopOnExit).toHaveBeenCalledTimes(1);
    const dispose = vi.spyOn(controller, 'dispose');
    (stopOnExit.mock.calls[0]?.[0] as () => void)();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
