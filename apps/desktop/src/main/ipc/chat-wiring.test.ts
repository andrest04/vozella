import { requestChannels, type RequestName } from '@vozella/contracts';
import {
  ChatService,
  InMemoryChatThreadRepository,
  InMemoryProjectContextSource,
  type ChatMeetingReader,
  type Logger,
} from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../chat/chat-controller';
import type { IpcEventLike } from '../security/trusted-origin';
import { registerChatHandlers } from './chat-handlers';
import type { IpcMainLike } from './ipc-server';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const event: IpcEventLike = {
  sender: { id: 1 },
  senderFrame: { url: 'vozella://app/index.html', parent: null },
};
const scope = (kind: string, projectId: string | null = null) => ({
  isVisible: true,
  kind,
  projectId,
  meetingId: null,
});
const PROJECT = '9f1c2d3e-0000-4000-8000-000000000001';

const reader: ChatMeetingReader = {
  meetingById: () => Promise.resolve(null),
  meetingsInProject: () => Promise.resolve([]),
  listRecent: () => Promise.resolve([]),
  listProjects: () => Promise.resolve([]),
};

/** The real ChatService behind the real controller and handlers; only the edges are doubles. */
function wire() {
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (name, listener) => void handlers.set(name, listener) };
  const events: { name: string; payload: unknown }[] = [];
  const service = new ChatService({
    meetings: reader,
    providers: {
      resolve: () =>
        Promise.resolve({
          status: 'ready',
          provider: {
            streamPrompt: async function* () {
              yield 'ok';
            },
          },
        }),
    },
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z'), nowMs: () => 0 } as never,
    translate: (key: string) => key,
    newId: () => crypto.randomUUID(),
    threads: new InMemoryChatThreadRepository(),
    projects: new InMemoryProjectContextSource(),
  });
  const controller = new ChatController({
    service,
    findMeetingId: () => Promise.resolve(null),
    writeClipboard: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
    broadcast: (channel, payload) => events.push({ name: channel.name, payload }),
    logger: logger(),
  });
  registerChatHandlers({ server: { ipc, logger: logger(), isTrusted: () => true }, controller });
  const call = async (name: RequestName, input: unknown): Promise<unknown> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(event as never, input);
  };
  return { call, events };
}

describe('chat scope mismatch through the real service', () => {
  it('shows the banner after a scope change, broadcasts it, and clears it on New chat', async () => {
    expect(Object.keys(requestChannels)).toContain('chat.setScope');
    const { call, events } = wire();
    await call('chat.send', {
      requestId: 'r1',
      draft: 'hello',
      scope: scope('AllMeetings'),
      liveTranscript: null,
    });
    const before = (await call('chat.setScope', { scope: scope('AllMeetings') })) as {
      value: { showScopeMismatch: boolean };
    };
    expect(before.value.showScopeMismatch).toBe(false);

    const after = (await call('chat.setScope', { scope: scope('Live') })) as {
      value: { showScopeMismatch: boolean };
    };
    expect(after.value.showScopeMismatch).toBe(true);
    const last = events.filter((e) => e.name === 'chat.stateChanged').at(-1);
    expect(
      (last?.payload as { state: { showScopeMismatch: boolean } }).state.showScopeMismatch,
    ).toBe(true);

    await call('chat.newChat', {});
    const cleared = (await call('chat.state', {})) as { value: { showScopeMismatch: boolean } };
    expect(cleared.value.showScopeMismatch).toBe(false);
  });
});

describe('chat history through the real service', () => {
  it('saves a turn, lists it, reopens it, renames it and deletes it', async () => {
    const { call, events } = wire();
    await call('chat.send', {
      requestId: 'r1',
      draft: 'What is a limit?',
      scope: scope('Project', PROJECT),
      liveTranscript: null,
    });
    expect(events.filter((e) => e.name === 'chat.threads.changed').map((e) => e.payload)).toEqual([
      { projectId: PROJECT },
    ]);

    const listed = (await call('chat.threads.list', { projectId: PROJECT })) as {
      value: { threads: { id: string; title: string; messageCount: number }[] };
    };
    expect(listed.value.threads).toHaveLength(1);
    const thread = listed.value.threads[0];
    expect(thread).toMatchObject({ title: 'What is a limit?', messageCount: 2 });
    const threadId = thread?.id ?? '';
    const state = (await call('chat.state', {})) as { value: { threadId: string | null } };
    expect(state.value.threadId).toBe(threadId);

    await call('chat.newChat', {});
    const opened = (await call('chat.threads.open', { projectId: PROJECT, id: threadId })) as {
      value: {
        ok: boolean;
        state: { threadId: string; hasMessages: boolean };
        thread: { scope: unknown; scopeStatus: string; messages: { text: string }[] };
      };
    };
    expect(opened.value.ok).toBe(true);
    expect(opened.value.state).toMatchObject({ threadId, hasMessages: true });
    expect(opened.value.thread.scope).toEqual({
      kind: 'Project',
      projectId: PROJECT,
      meetingId: null,
    });
    expect(opened.value.thread.scopeStatus).toBe('ok');
    expect(opened.value.thread.messages.map((m) => m.text)).toEqual(['What is a limit?', 'ok']);

    expect(
      await call('chat.threads.rename', { projectId: PROJECT, id: threadId, title: 'Midterm' }),
    ).toMatchObject({ value: { ok: true } });
    expect(await call('chat.threads.delete', { projectId: PROJECT, id: threadId })).toMatchObject({
      value: { ok: true },
    });
    const after = (await call('chat.state', {})) as {
      value: { threadId: string | null; hasMessages: boolean };
    };
    expect(after.value).toMatchObject({ threadId: null, hasMessages: false });
    expect(await call('chat.threads.list', { projectId: PROJECT })).toMatchObject({
      value: { threads: [] },
    });
  });

  it('a thread that is not there is not-found, not an error', async () => {
    const { call } = wire();
    expect(
      await call('chat.threads.open', {
        projectId: null,
        id: '7a000000-0000-4000-8000-000000000001',
      }),
    ).toMatchObject({ value: { ok: false, reason: 'not-found' } });
  });
});
