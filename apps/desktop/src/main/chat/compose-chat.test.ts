import type {
  ChatThreadRepository,
  ProjectContextSource,
  SummaryProviderResolver,
} from '@vozella/core';
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
      projects: {},
      paths: { chatPromptsFilePath: 'C:/app-data/chat-prompts.json' },
    } as unknown as Pick<LibraryRuntime, 'meetings' | 'projects' | 'paths'>,
    resolver: {} as SummaryProviderResolver,
    logger: silentLogger(),
    translate: (key) => key,
    uiLanguage: () => 'en-US',
    liveContext: () => ({ digest: null, title: null, notes: null, projectId: null }),
    broadcast: vi.fn(),
    server,
    dialogs,
    tempDirectory: () => 'C:/temp',
    documentsDirectory: () => 'C:/Documents',
    extractor: () => Promise.resolve({ ok: false, reason: 'unreadable' }),
    projectContext: {} as ProjectContextSource,
    threads: {} as ChatThreadRepository,
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
    expect([...channels]).toEqual(
      expect.arrayContaining(['chat.threads.list', 'chat.threads.open']),
    );
  });

  it('returns the service the live ask reads', () => {
    const { composed } = compose();
    expect(composed.service.localAnswerInFlight).toBe(false);
  });
});
