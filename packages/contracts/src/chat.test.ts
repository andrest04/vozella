import { describe, expect, it } from 'vitest';
import {
  chatAttachDrop,
  chatAttachList,
  chatAttachPick,
  chatAttachRemove,
  chatCancel,
  chatCopyText,
  chatMeetingExists,
  chatOpenExternal,
  chatSend,
  chatSendOutcomeSchema,
  chatSetScope,
  chatState,
  chatStateSchema,
  chatThreadsChanged,
  chatThreadsDelete,
  chatThreadsList,
  chatThreadsOpen,
  chatThreadsRename,
  chatFailureKindSchema,
  chatScopeSchema,
  chatThreadSummarySchema,
  threadScopeSchema,
  eventChannels,
  requestChannels,
} from './index';

const scope = { isVisible: true, kind: 'Meeting', projectId: null, meetingId: 'm-1' } as const;
const message = (role: 'user' | 'assistant') => ({
  id: 'x',
  role,
  text: 't',
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('chat contracts', () => {
  it('registers every chat request and event by name', () => {
    for (const name of [
      'chat.send',
      'chat.cancel',
      'chat.newChat',
      'chat.state',
      'chat.setScope',
      'chat.meetingExists',
      'chat.copyText',
      'chat.openExternal',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
    expect(Object.keys(eventChannels)).toContain('chat.chunk');
    expect(Object.keys(eventChannels)).toContain('chat.stateChanged');
  });

  it('accepts a send with a scope and a live transcript snapshot', () => {
    const input = { requestId: 'r1', draft: 'hi', scope, liveTranscript: null };
    expect(chatSend.input.safeParse(input).success).toBe(true);
    expect(chatSend.input.safeParse({ ...input, liveTranscript: 'Ana: hi' }).success).toBe(true);
  });

  it('refuses a send with a missing request id, an unknown scope kind or no transcript field', () => {
    const input = { requestId: 'r1', draft: 'hi', scope, liveTranscript: null };
    expect(chatSend.input.safeParse({ ...input, requestId: '' }).success).toBe(false);
    expect(
      chatSend.input.safeParse({ ...input, scope: { ...scope, kind: 'Everything' } }).success,
    ).toBe(false);
    expect(chatSetScope.input.safeParse({ scope: { ...scope, isVisible: 'yes' } }).success).toBe(
      false,
    );
    expect(chatSend.input.safeParse({ requestId: 'r1', draft: 'hi', scope }).success).toBe(false);
  });

  it('every send outcome is a value the schema accepts', () => {
    const outcomes: unknown[] = [
      { status: 'answered', user: message('user'), assistant: message('assistant') },
      { status: 'setup-required', kind: 'Local', originalDraft: 'q' },
      { status: 'failed', kind: 'send-failed', message: 'm', originalDraft: 'q' },
      { status: 'cancelled', originalDraft: 'q' },
      { status: 'empty' },
    ];
    for (const outcome of outcomes) {
      expect(chatSendOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    expect(chatSendOutcomeSchema.safeParse({ status: 'setup-required', kind: 'Xai' }).success).toBe(
      false,
    );
    expect(chatSendOutcomeSchema.safeParse({ status: 'failed', message: 'm' }).success).toBe(false);
  });

  it('refuses malformed small requests', () => {
    expect(chatCancel.input.safeParse({ extra: 1 }).success).toBe(false);
    expect(chatCopyText.input.safeParse({ text: '' }).success).toBe(false);
    expect(chatMeetingExists.input.safeParse({ meetingId: '' }).success).toBe(false);
    expect(chatOpenExternal.input.safeParse({ url: 'https://a.test' }).success).toBe(true);
    expect(chatOpenExternal.input.safeParse({ url: '' }).success).toBe(false);
  });
});

describe('chat attachment contracts', () => {
  const attachment = {
    id: 'att-1',
    name: 'plan.pdf',
    kind: 'pdf',
    sizeBytes: 1200,
    pages: 2,
    status: 'ready',
    message: null,
    truncated: false,
  } as const;

  it('registers the attach requests', () => {
    for (const name of [
      'chat.attach.pick',
      'chat.attach.drop',
      'chat.attach.remove',
      'chat.attach.list',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
  });

  it('send carries at most 10 attachment ids, and none by default', () => {
    const base = { requestId: 'r', draft: 'q', scope, liveTranscript: null };
    expect(chatSend.input.parse(base).attachmentIds).toEqual([]);
    expect(chatSend.input.parse({ ...base, attachmentIds: ['a'] }).attachmentIds).toEqual(['a']);
    const eleven = Array.from({ length: 11 }, (_, i) => `a${String(i)}`);
    expect(chatSend.input.safeParse({ ...base, attachmentIds: eleven }).success).toBe(false);
  });

  it('the list answer carries chips and an optional notice', () => {
    const parsed = chatAttachPick.output.parse({ attachments: [attachment], notice: null });
    expect(parsed.attachments[0]?.kind).toBe('pdf');
    expect(
      chatAttachList.output.safeParse({
        attachments: [{ ...attachment, kind: 'exe' }],
        notice: null,
      }).success,
    ).toBe(false);
  });

  it('drop takes 1 to 10 paths of bounded length; remove takes an id', () => {
    expect(chatAttachDrop.input.safeParse({ paths: [] }).success).toBe(false);
    expect(chatAttachDrop.input.safeParse({ paths: ['/tmp/a.txt'] }).success).toBe(true);
    expect(chatAttachDrop.input.safeParse({ paths: ['x'.repeat(5000)] }).success).toBe(false);
    expect(chatAttachRemove.input.safeParse({ id: 'att-1' }).success).toBe(true);
  });

  it('an answer may carry a notice, null by default', () => {
    const answered = chatSendOutcomeSchema.parse({
      status: 'answered',
      user: message('user'),
      assistant: message('assistant'),
    });
    expect(answered).toMatchObject({ notice: null });
  });

  it('an answer may say how many meetings it was based on, of how many matched', () => {
    const base = { status: 'answered', user: message('user'), assistant: message('assistant') };
    const coverage = { used: 12, matching: 37, basis: 'relevance' };
    expect(chatSendOutcomeSchema.parse({ ...base, coverage })).toMatchObject({ coverage });
    expect(chatSendOutcomeSchema.parse(base)).not.toHaveProperty('coverage');
    for (const bad of [
      { used: -1, matching: 3, basis: 'recency' },
      { used: 1.5, matching: 3, basis: 'recency' },
      { used: 1, matching: 3, basis: 'newest' },
      { used: 1, matching: 3, basis: 'recency', extra: true },
    ]) {
      expect(chatSendOutcomeSchema.safeParse({ ...base, coverage: bad }).success).toBe(false);
    }
  });

  it('the chat state lists the attachments, empty by default', () => {
    const state = chatState.output.parse({
      messages: [],
      isSending: false,
      showScopeMismatch: false,
      hasMessages: false,
      canStartNewChat: true,
    });
    expect(state.attachments).toEqual([]);
  });
});

const PROJECT = '9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b';
const THREAD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AT = '2026-11-16T14:03:00.000Z';

describe('chat history contracts', () => {
  it('registers the thread requests and the changed event', () => {
    for (const name of [
      'chat.threads.list',
      'chat.threads.open',
      'chat.threads.rename',
      'chat.threads.delete',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
    expect(Object.keys(eventChannels)).toContain('chat.threads.changed');
  });

  it('the scope kind is Project, not Folder, and carries a lowercase project id', () => {
    const project = { isVisible: true, kind: 'Project', projectId: PROJECT, meetingId: null };
    expect(chatScopeSchema.parse({ ...project, projectId: PROJECT.toUpperCase() })).toEqual(
      project,
    );
    expect(chatScopeSchema.safeParse({ ...project, kind: 'Folder' }).success).toBe(false);
    expect(
      chatScopeSchema.safeParse({ ...project, folderId: PROJECT, projectId: undefined }).success,
    ).toBe(false);
    expect(chatScopeSchema.safeParse({ ...project, projectId: '../x' }).success).toBe(false);
  });

  it('a thread scope names its owner and, for Meeting, the meeting', () => {
    const scope = { kind: 'Meeting', projectId: PROJECT, meetingId: 'm1' };
    expect(threadScopeSchema.parse(scope)).toEqual(scope);
    expect(
      threadScopeSchema.safeParse({ kind: 'AllMeetings', projectId: null, meetingId: null })
        .success,
    ).toBe(true);
  });

  it('the chat state tells which thread is open and whether the history is saved', () => {
    const base = {
      messages: [],
      isSending: false,
      showScopeMismatch: false,
      hasMessages: false,
      canStartNewChat: true,
    };
    expect(chatStateSchema.parse(base)).toMatchObject({ threadId: null, historySaved: true });
    expect(chatStateSchema.parse({ ...base, threadId: THREAD, historySaved: false })).toMatchObject(
      {
        threadId: THREAD,
        historySaved: false,
      },
    );
    expect(chatStateSchema.safeParse({ ...base, threadId: 'x' }).success).toBe(false);
  });

  it('lists threads of an owner or of no project, newest first as the adapter orders them', () => {
    expect(chatThreadsList.input.parse({ projectId: null })).toEqual({ projectId: null });
    expect(chatThreadsList.input.parse({ projectId: PROJECT.toUpperCase() })).toEqual({
      projectId: PROJECT,
    });
    expect(chatThreadsList.input.safeParse({}).success).toBe(false);
    const summary = {
      id: THREAD,
      ownerProjectId: PROJECT,
      scope: { kind: 'Project', meetingId: null },
      title: 'Exam dates',
      updatedAt: AT,
      messageCount: 4,
    };
    expect(chatThreadSummarySchema.parse(summary)).toEqual(summary);
    expect(chatThreadsList.output.parse({ threads: [summary] })).toEqual({ threads: [summary] });
  });

  it('opens a thread with its state, messages, full scope and scope status', () => {
    const thread = {
      id: THREAD,
      title: 'Exam dates',
      scope: { kind: 'Meeting', projectId: PROJECT, meetingId: 'm1' },
      messages: [{ id: 'a', role: 'user', text: 'When?', createdAt: AT }],
      scopeStatus: 'meeting-missing',
    };
    const state = {
      messages: [],
      isSending: false,
      showScopeMismatch: false,
      hasMessages: true,
      canStartNewChat: true,
    };
    const parsed = chatThreadsOpen.output.parse({ ok: true, state, thread });
    expect(parsed).toMatchObject({ ok: true, thread });
    for (const reason of ['busy', 'not-found', 'corrupt']) {
      expect(chatThreadsOpen.output.safeParse({ ok: false, reason }).success).toBe(true);
    }
    expect(chatThreadsOpen.output.safeParse({ ok: false, reason: 'gone' }).success).toBe(false);
    expect(
      chatThreadsOpen.output.safeParse({ ok: true, state, thread: { ...thread, scopeStatus: 'x' } })
        .success,
    ).toBe(false);
    for (const scopeStatus of ['ok', 'meeting-missing', 'live-ended']) {
      expect(
        chatThreadsOpen.output.safeParse({ ok: true, state, thread: { ...thread, scopeStatus } })
          .success,
      ).toBe(true);
    }
  });

  it('renames and deletes by owner and id, with GUIDs only', () => {
    expect(
      chatThreadsRename.input.parse({ projectId: null, id: THREAD, title: '  New  ' }),
    ).toEqual({
      projectId: null,
      id: THREAD,
      title: 'New',
    });
    expect(
      chatThreadsRename.input.safeParse({ projectId: null, id: THREAD, title: '   ' }).success,
    ).toBe(false);
    expect(
      chatThreadsRename.input.safeParse({ projectId: null, id: '../x', title: 'T' }).success,
    ).toBe(false);
    expect(chatThreadsDelete.input.safeParse({ projectId: PROJECT, id: THREAD }).success).toBe(
      true,
    );
    expect(chatThreadsDelete.input.safeParse({ projectId: PROJECT, id: 'x' }).success).toBe(false);
    expect(chatThreadsDelete.output.parse({ ok: false })).toEqual({ ok: false });
    expect(chatThreadsChanged.payload.parse({ projectId: null })).toEqual({ projectId: null });
  });

  it('chat.send can fail because the thread scope is gone', () => {
    expect(chatFailureKindSchema.safeParse('scope-gone').success).toBe(true);
    const failed = { status: 'failed', kind: 'scope-gone', message: 'm', originalDraft: 'd' };
    expect(chatSendOutcomeSchema.safeParse(failed).success).toBe(true);
  });
});
