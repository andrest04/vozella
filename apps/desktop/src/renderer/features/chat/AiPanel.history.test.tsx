// @vitest-environment jsdom
import type { ChatThreadSummaryDto, WorkspaceStateDto } from '@vozella/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestChat, takeChatRequest } from '../../app/chat-requests';
import { Providers } from '../../app/test-providers';
import { guid } from '../../test-support/project-fixtures';
import {
  installVozella,
  uninstallVozella,
  type VozellaMock,
} from '../../test-support/vozella-mock';
import { AiPanelArea } from './AiPanel';

const PROJECT = guid(1);
const MEETING = '11111111-1111-4111-8111-111111111111';

let workspace: WorkspaceStateDto;
let threads: ChatThreadSummaryDto[];
let mock: VozellaMock;

const summary = (
  n: number,
  title: string,
  scope: ChatThreadSummaryDto['scope'],
  owner: string | null = PROJECT,
): ChatThreadSummaryDto => ({
  id: guid(200 + n),
  ownerProjectId: owner,
  scope,
  title,
  updatedAt: `2026-0${String(n)}-01T12:00:00.000Z`,
  messageCount: 2,
});

function install(initial: Partial<WorkspaceStateDto> = {}) {
  workspace = {
    selectedMeetingId: null,
    lastProcessedMeetingId: null,
    sessionTab: 'Transcript',
    currentShellTag: 'History',
    selectedProjectId: PROJECT,
    liveTranscript: '',
    isCaptureActive: false,
    ...initial,
  };
  threads = [
    summary(1, 'Exam question', { kind: 'Project', meetingId: null }),
    summary(2, 'About the sync', { kind: 'Meeting', meetingId: MEETING }),
  ];
  mock = installVozella({
    'workspace.getState': () => workspace,
    'library.getMeeting': ({ id }) => ({
      record: id === MEETING ? ({ title: 'Weekly planning', projectId: PROJECT } as never) : null,
    }),
    'projects.list': () => ({
      projects: [
        {
          id: PROJECT,
          name: 'Calculo',
          description: '',
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          meetingCount: 0,
          fileCount: 0,
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      noProject: { meetingCount: 0, lastActivityAt: null },
      skipped: [],
      storage: { status: 'ready' as const },
    }),
    'chat.setScope': () => ({ canStartNewChat: true }) as never,
    'chat.newChat': () => ({ started: true }),
    'recording.getState': () => ({}) as never,
    'chat.threads.list': ({ projectId }) => ({
      threads: threads.filter((thread) => thread.ownerProjectId === projectId),
    }),
    'chat.threads.open': ({ projectId, id }) => {
      const thread = threads.find((t) => t.id === id && t.ownerProjectId === projectId);
      if (!thread) return { ok: false as const, reason: 'not-found' as const };
      return {
        ok: true as const,
        state: {} as never,
        thread: {
          id,
          title: thread.title,
          scope: { ...thread.scope, projectId },
          messages: [],
          scopeStatus: 'ok' as const,
        },
      };
    },
    'chat.threads.delete': ({ id }) => {
      threads = threads.filter((t) => t.id !== id);
      return { ok: true };
    },
    'chat.threads.rename': ({ id, title }) => {
      threads = threads.map((t) => (t.id === id ? { ...t, title } : t));
      return { ok: true };
    },
  });
}

HTMLElement.prototype.setPointerCapture = () => undefined;
HTMLElement.prototype.releasePointerCapture = () => undefined;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('vozella.aiPanel.open', 'true');
});

afterEach(() => {
  cleanup();
  uninstallVozella();
  takeChatRequest();
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

const mount = () =>
  render(
    <Providers>
      <AiPanelArea
        body={(scope, thread) => (
          <p data-testid="body">
            {scope.kind}|{String(scope.meetingId)}|{String(thread.readOnly)}
          </p>
        )}
      >
        <input aria-label="Page field" />
      </AiPanelArea>
    </Providers>,
  );

const chip = () => screen.getByTestId('LblMeetingChatScope');

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('BtnMeetingChatHistory'));
  return screen.findByRole('dialog', { name: 'Chat history' });
}

describe('AiPanel History', () => {
  it('lists the saved chats of the current owner, newest first, with a New chat action', async () => {
    install();
    const user = userEvent.setup();
    mount();
    const popover = await openHistory(user);
    const rows = await within(popover).findAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('About the sync'),
      expect.stringContaining('Exam question'),
    ]);
    expect(within(popover).getByRole('button', { name: 'New chat' })).toBeEnabled();
    expect(mock.inputsOf('chat.threads.list')).toEqual([{ projectId: PROJECT }]);
  });

  it('says there are no chats yet for an owner with none', async () => {
    install({ selectedProjectId: null, currentShellTag: 'Recording' });
    const user = userEvent.setup();
    mount();
    const popover = await openHistory(user);
    expect(
      await within(popover).findByText('No chats yet. Ask about your meetings.'),
    ).toBeInTheDocument();
    expect(mock.inputsOf('chat.threads.list')).toEqual([{ projectId: null }]);
  });

  it('opening a chat reopens it in main and pins its scope, whatever the page is', async () => {
    install();
    const user = userEvent.setup();
    mount();
    await waitFor(() => {
      expect(chip().textContent).toBe('Project: Calculo');
    });
    const popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^About the sync/ }));
    expect(mock.inputsOf('chat.threads.open')).toEqual([{ projectId: PROJECT, id: guid(202) }]);
    await waitFor(() => {
      expect(chip().textContent).toBe('Meeting: Weekly planning');
    });
    expect(screen.getByTestId('body')).toHaveTextContent(`Meeting|${MEETING}|null`);
    // The page still says Project to main, so its mismatch notice can explain the difference.
    expect(mock.inputsOf('chat.setScope').at(-1)).toMatchObject({
      scope: { kind: 'Project', projectId: PROJECT },
    });
  });

  it('the pin holds across a library change, and ends when the page changes', async () => {
    install();
    const user = userEvent.setup();
    mount();
    const popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^About the sync/ }));
    await waitFor(() => {
      expect(chip().textContent).toBe('Meeting: Weekly planning');
    });
    act(() => {
      mock.emit('library.changed', { reason: 'meeting' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(chip().textContent).toBe('Meeting: Weekly planning');
    workspace = { ...workspace, currentShellTag: 'Recording', selectedProjectId: null };
    act(() => {
      mock.emit('workspace.changed', { state: workspace });
    });
    await waitFor(() => {
      expect(chip().textContent).toBe('All meetings');
    });
  });

  it('New chat ends the pin and asks main for a fresh conversation', async () => {
    install();
    const user = userEvent.setup();
    mount();
    const popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^About the sync/ }));
    await waitFor(() => {
      expect(chip().textContent).toBe('Meeting: Weekly planning');
    });
    await user.click(screen.getByTestId('BtnMeetingChatNew'));
    await waitFor(() => {
      expect(chip().textContent).toBe('Project: Calculo');
    });
    expect(mock.inputsOf('chat.newChat')).toHaveLength(1);
  });

  it('a thread whose meeting is gone opens read only, and the body is told why', async () => {
    install();
    const user = userEvent.setup();
    mount();
    mock.handle('chat.threads.open', ({ projectId, id }) => ({
      ok: true as const,
      state: {} as never,
      thread: {
        id,
        title: 'Old',
        scope: { kind: 'Meeting' as const, projectId, meetingId: 'gone' },
        messages: [],
        scopeStatus: 'meeting-missing' as const,
      },
    }));
    const popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^About the sync/ }));
    await waitFor(() => {
      expect(screen.getByTestId('body')).toHaveTextContent('Meeting|gone|meeting-missing');
    });
  });

  it('says a chat could not be opened, and that an answer in progress must finish first', async () => {
    install();
    const user = userEvent.setup();
    mount();
    mock.handle('chat.threads.open', () => ({ ok: false as const, reason: 'busy' as const }));
    let popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^About the sync/ }));
    expect(await screen.findByTestId('TxtChatHistoryNotice')).toHaveTextContent(
      'Wait for the answer to finish before opening another chat.',
    );
    mock.handle('chat.threads.open', () => ({ ok: false as const, reason: 'corrupt' as const }));
    popover = await openHistory(user);
    await user.click(await within(popover).findByRole('button', { name: /^Exam question/ }));
    await waitFor(() => {
      expect(screen.getByTestId('TxtChatHistoryNotice')).toHaveTextContent(
        'That chat could not be opened.',
      );
    });
  });

  it('deletes a chat after a confirmation, and renames one in place', async () => {
    install();
    const user = userEvent.setup();
    mount();
    let popover = await openHistory(user);
    await user.click(
      await within(popover).findByRole('button', { name: 'Actions for Exam question' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await within(popover).findByRole('textbox', { name: 'Rename' });
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    await waitFor(() => {
      expect(threads.some((t) => t.title === 'Renamed')).toBe(true);
    });
    popover = screen.getByRole('dialog', { name: 'Chat history' });
    await user.click(
      await within(popover).findByRole('button', { name: 'Actions for About the sync' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(threads.map((t) => t.title)).toEqual(['Renamed']);
    });
  });

  it('opens a thread another page asked for, with its owner', async () => {
    install();
    mount();
    await waitFor(() => {
      expect(chip().textContent).toBe('Project: Calculo');
    });
    act(() => {
      requestChat({ kind: 'open-thread', projectId: PROJECT, threadId: guid(202) });
    });
    await waitFor(() => {
      expect(mock.inputsOf('chat.threads.open')).toEqual([{ projectId: PROJECT, id: guid(202) }]);
    });
    await waitFor(() => {
      expect(chip().textContent).toBe('Meeting: Weekly planning');
    });
  });

  it('a New chat request from a page opens the panel and starts a fresh chat', async () => {
    install();
    mount();
    await waitFor(() => {
      expect(chip().textContent).toBe('Project: Calculo');
    });
    act(() => {
      requestChat({ kind: 'new-chat', projectId: PROJECT });
    });
    await waitFor(() => {
      expect(mock.inputsOf('chat.newChat')).toHaveLength(1);
    });
  });
});
