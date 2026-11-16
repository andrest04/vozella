import { requestChannels, type RequestName } from '@vozella/contracts';
import type { ApiKeyStore, Logger } from '@vozella/core';
import {
  FakeApiKeyStore,
  FakeFetch,
  TranscriptionProviderKeys,
  type FakeHttpReply,
} from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import type { IpcEventLike } from '../security/trusted-origin';
import type { TranscriptionController } from '../transcription/transcription-controller';
import type { IpcMainLike } from './ipc-server';
import { registerTranscriptionHandlers } from './transcription-handlers';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};

const status = {
  ready: true,
  engine: 'Local' as const,
  cloudNotReadyReason: null,
  modelInstalled: true,
  runtimes: { cpu: true, cuda: false },
  speakerModelInstalled: false,
  expectedBackend: 'cpu' as const,
  usage: null,
  liveDroppedPercent: null,
  liveEnabled: true,
  speakerLabelsEnabled: false,
  language: 'es',
  installing: null,
};

function setup(trusted = true, reply: FakeHttpReply = {}) {
  const store: ApiKeyStore = new FakeApiKeyStore();
  const fetch = new FakeFetch(reply);
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const controller = {
    status: vi.fn(() => Promise.resolve(status)),
    ensureEngine: vi.fn(() => Promise.resolve({ status: 'ready' as const })),
    cancelInstall: vi.fn(() => true),
    deleteEngine: vi.fn(() => Promise.resolve('RuntimeInUse' as const)),
    setLiveEnabled: vi.fn(() => Promise.resolve(true)),
    setSpeakerLabels: vi.fn(() => Promise.resolve({ status: 'saved' as const, enabled: true })),
    downloadSpeakerModel: vi.fn(() => Promise.resolve({ status: 'ready' as const })),
    deleteSpeakerModel: vi.fn(() => Promise.resolve({ status: 'deleted' as const })),
    retranscriptionAvailability: vi.fn(() => Promise.resolve('Available' as const)),
    startRetranscription: vi.fn(() => Promise.resolve({ started: true as const, reason: null })),
    cancelRetranscription: vi.fn(),
    dismissRetranscription: vi.fn(),
    retranscriptionSnapshot: vi.fn(() => ({
      isRunning: false,
      meetingId: null,
      status: '',
      lastResults: [{ meetingId: 'm1', outcome: 'Failed' as const, message: 'boom' }],
    })),
    retranscription: { isRunning: false, meetingId: null, status: '' },
    refreshStatus: vi.fn(() => Promise.resolve()),
  };
  registerTranscriptionHandlers({
    server: { ipc, logger: logger(), isTrusted: () => trusted },
    controller: controller as unknown as TranscriptionController,
    providerKeys: new TranscriptionProviderKeys({ keys: store, fetch: fetch.fetch }),
  });
  const call = async (name: RequestName, input: unknown): Promise<unknown> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(event as never, input);
  };
  return { call, controller, handlers, store, fetch };
}

describe('transcription handlers', () => {
  it('registers every transcription and re-transcription request channel', () => {
    const { handlers } = setup();
    const names = Object.keys(requestChannels).filter(
      (n) => n.startsWith('transcription.') || n.startsWith('retranscription.'),
    );
    expect(names.sort()).toEqual([...handlers.keys()].sort());
  });

  it('answers the status and the engine commands', async () => {
    const { call, controller } = setup();
    expect(await call('transcription.getStatus', {})).toMatchObject({
      ok: true,
      value: { ready: true },
    });
    expect(await call('transcription.ensureEngine', {})).toMatchObject({
      ok: true,
      value: { status: 'ready' },
    });
    expect(await call('transcription.cancelInstall', {})).toMatchObject({
      ok: true,
      value: { cancelled: true },
    });
    expect(await call('transcription.deleteEngine', {})).toMatchObject({
      ok: true,
      value: { outcome: 'RuntimeInUse' },
    });
    expect(controller.ensureEngine).toHaveBeenCalledTimes(1);
  });

  it('changes the two settings through the controller', async () => {
    const { call, controller } = setup();
    expect(await call('transcription.setLiveEnabled', { enabled: false })).toMatchObject({
      ok: true,
      value: { saved: true },
    });
    expect(controller.setLiveEnabled).toHaveBeenCalledWith(false);
    await call('transcription.setSpeakerLabels', { enabled: true });
    expect(controller.setSpeakerLabels).toHaveBeenCalledWith(true);
    await call('transcription.downloadSpeakerModel', {});
    await call('transcription.deleteSpeakerModel', {});
    expect(controller.deleteSpeakerModel).toHaveBeenCalled();
  });

  it('rejects input the contract does not allow, before the controller', async () => {
    const { call, controller } = setup();
    expect(await call('transcription.setLiveEnabled', { enabled: 'yes' })).toMatchObject({
      ok: false,
    });
    expect(await call('retranscription.start', { meetingId: '' })).toMatchObject({ ok: false });
    expect(controller.setLiveEnabled).not.toHaveBeenCalled();
    expect(controller.startRetranscription).not.toHaveBeenCalled();
  });

  it('runs re-transcription through the controller', async () => {
    const { call, controller } = setup();
    expect(await call('retranscription.availability', { meetingId: 'm1' })).toMatchObject({
      ok: true,
      value: { availability: 'Available' },
    });
    expect(await call('retranscription.start', { meetingId: 'm1' })).toMatchObject({
      ok: true,
      value: { started: true, reason: null },
    });
    expect(await call('retranscription.cancel', {})).toMatchObject({ ok: true });
    expect(controller.cancelRetranscription).toHaveBeenCalled();
    expect(await call('retranscription.getState', {})).toMatchObject({
      ok: true,
      value: { isRunning: false, lastResults: [{ meetingId: 'm1', outcome: 'Failed' }] },
    });
    expect(await call('retranscription.dismiss', { meetingId: 'm1' })).toMatchObject({
      ok: true,
      value: { dismissed: true },
    });
    expect(controller.dismissRetranscription).toHaveBeenCalledWith('m1');
    expect(await call('retranscription.dismiss', { meetingId: '' })).toMatchObject({ ok: false });
  });

  it('saves and removes the key of a transcription-only provider, and publishes the status after each', async () => {
    const { call, controller, store } = setup();
    const secret = 'dg-secret-key-123';
    const saved = await call('transcription.setProviderKey', { kind: 'Deepgram', key: secret });
    expect(saved).toEqual({ ok: true, value: { status: 'saved', keySet: true } });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(await store.get('Deepgram')).toBe(secret);
    expect(controller.refreshStatus).toHaveBeenCalledTimes(1);

    const cleared = await call('transcription.clearProviderKey', { kind: 'Deepgram' });
    expect(cleared).toEqual({ ok: true, value: { status: 'saved', keySet: false } });
    expect(await store.has('Deepgram')).toBe(false);
    expect(controller.refreshStatus).toHaveBeenCalledTimes(2);
  });

  it('verifies the saved key against the provider without changing anything', async () => {
    const accepted = setup(true, { chunks: ['{"projects":[]}'] });
    await accepted.store.set('Deepgram', 'dg-key');
    expect(await accepted.call('transcription.verifyProviderKey', { kind: 'Deepgram' })).toEqual({
      ok: true,
      value: { status: 'verified' },
    });
    expect(accepted.fetch.calls.map((request) => request.url)).toEqual([
      'https://api.deepgram.com/v1/projects',
    ]);
    expect(accepted.controller.refreshStatus).not.toHaveBeenCalled();

    const refused = setup(true, { status: 401 });
    await refused.store.set('Deepgram', 'dg-wrong');
    expect(await refused.call('transcription.verifyProviderKey', { kind: 'Deepgram' })).toEqual({
      ok: true,
      value: { status: 'failed', errorKey: 'Ui_ApiKeyInvalid' },
    });
  });

  it('takes no API engine on the provider key channels', async () => {
    const { call, store, controller } = setup();
    for (const kind of ['Groq', 'OpenAi', 'Local']) {
      expect(await call('transcription.setProviderKey', { kind, key: 'k' })).toMatchObject({
        ok: false,
      });
      expect(await call('transcription.clearProviderKey', { kind })).toMatchObject({ ok: false });
      expect(await call('transcription.verifyProviderKey', { kind })).toMatchObject({ ok: false });
    }
    expect(await store.has('Groq')).toBe(false);
    expect(controller.refreshStatus).not.toHaveBeenCalled();
  });

  it('refuses an untrusted sender', async () => {
    const { call, controller } = setup(false);
    expect(await call('transcription.deleteEngine', {})).toMatchObject({
      ok: false,
      error: { code: 'untrusted-sender' },
    });
    expect(controller.deleteEngine).not.toHaveBeenCalled();
  });

  it('an untrusted sender cannot save a key', async () => {
    const { call, store } = setup(false);
    expect(
      await call('transcription.setProviderKey', { kind: 'Deepgram', key: 'dg-key' }),
    ).toMatchObject({ ok: false, error: { code: 'untrusted-sender' } });
    expect(await store.has('Deepgram')).toBe(false);
  });
});
