import type { SummaryProviderResolver } from '@vozella/core';
import type { LibraryRuntime } from '@vozella/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  noDialogs,
  recordingIpc,
  requestChannelsWithPrefix,
  silentLogger,
} from '../compose-test-kit';
import { composeChat, type ComposeChatDeps } from './compose-chat';

function compose(overrides: Partial<ComposeChatDeps> = {}) {
  const { server, channels } = recordingIpc();
  const dialogs = noDialogs();
  const composed = composeChat({
    library: {
      meetings: {},
      folders: {},
      paths: { chatPromptsFilePath: 'C:/app-data/chat-prompts.json' },
    } as unknown as Pick<LibraryRuntime, 'meetings' | 'folders' | 'paths'>,
    resolver: {} as SummaryProviderResolver,
    logger: silentLogger(),
    translate: (key) => key,
    uiLanguage: () => 'en-US',
    liveContext: () => ({ digest: null, title: null, notes: null }),
    broadcast: vi.fn(),
    server,
    dialogs,
    tempDirectory: () => 'C:/temp',
    documentsDirectory: () => 'C:/Documents',
    workersDirectory: 'C:/app/workers',
    writeClipboard: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
    ...overrides,
  });
  return { composed, channels, dialogs };
}

describe('composeChat', () => {
  it('registers every chat and saved prompt request channel once', () => {
    const { channels } = compose();
    expect([...channels].sort()).toEqual(requestChannelsWithPrefix('chat.'));
  });

  it('builds no worker until a document is attached', () => {
    // The extractor makes its worker thread on first use; composing must stay cheap.
    expect(() => compose({ workersDirectory: 'Z:/does-not-exist' })).not.toThrow();
  });

  it('returns the service the live ask reads', () => {
    const { composed } = compose();
    expect(composed.service.localAnswerInFlight).toBe(false);
  });
});
