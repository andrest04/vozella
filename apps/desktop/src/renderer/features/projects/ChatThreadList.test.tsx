// @vitest-environment jsdom
import type { ChatThreadSummaryDto } from '@vozella/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { takeChatRequest } from '../../app/chat-requests';
import { guid, installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { renderRouted } from '../../test-support/render-with-router';
import { uninstallVozella, type VozellaMock } from '../../test-support/vozella-mock';
import { useMeetingListStore } from '../meeting-list/meeting-list-store';
import { ChatThreadList } from './ChatThreadList';

const OWNER = guid(1);

afterEach(() => {
  uninstallVozella();
  takeChatRequest();
  useMeetingListStore.setState({ meetings: [], isLoading: true });
});

const thread = (
  n: number,
  title: string,
  scope: ChatThreadSummaryDto['scope'],
  updatedAt: string,
): ChatThreadSummaryDto => ({
  id: guid(100 + n),
  ownerProjectId: OWNER,
  scope,
  title,
  updatedAt,
  messageCount: 2,
});

async function mount(
  setup: (world: ProjectsWorld) => void,
  prepare: (mock: VozellaMock) => void = () => undefined,
) {
  const handles = installProjectsWorld(setup);
  prepare(handles.mock);
  useMeetingListStore.setState({
    isLoading: false,
    meetings: [
      {
        id: 'm1',
        title: 'Weekly sync',
        recordedAt: '2026-09-01T09:00:00.0000000+00:00',
        endedAt: null,
        projectId: OWNER,
        snippet: '',
        hasSummary: false,
        hasTranscript: false,
        busy: false,
      },
    ],
  });
  await renderRouted('/x', [{ path: '/x', component: () => <ChatThreadList owner={OWNER} /> }]);
  return { ...handles, user: userEvent.setup() };
}

const seed = (world: ProjectsWorld): void => {
  world.threads.set(OWNER, [
    thread(1, 'Older question', { kind: 'Project', meetingId: null }, '2026-03-01T12:00:00.000Z'),
    thread(2, 'About the sync', { kind: 'Meeting', meetingId: 'm1' }, '2026-05-01T12:00:00.000Z'),
    thread(
      3,
      'About a deleted meeting',
      { kind: 'Meeting', meetingId: 'gone' },
      '2026-04-01T12:00:00.000Z',
    ),
    thread(4, 'During a call', { kind: 'Live', meetingId: null }, '2026-02-01T12:00:00.000Z'),
  ]);
};

describe('ChatThreadList', () => {
  it('says what the empty list is for', async () => {
    await mount(() => undefined);
    expect(
      await screen.findByText("No chats yet. Ask about this project's meetings."),
    ).toBeInTheDocument();
  });

  it('says the chats could not be loaded instead of claiming there are none, and tries again', async () => {
    const { mock, world, user } = await mount(seed, (m) => {
      m.handle('chat.threads.list', () => {
        throw new Error('disk unavailable');
      });
    });
    expect(await screen.findByText('The chats could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/No chats yet/)).not.toBeInTheDocument();
    mock.handle('chat.threads.list', ({ projectId }) => ({
      threads: world.threads.get(projectId) ?? [],
    }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('About the sync')).toBeInTheDocument();
    expect(screen.queryByText('The chats could not be loaded.')).not.toBeInTheDocument();
  });

  it('lists the newest chat first with its date and a scope badge for each kind', async () => {
    await mount(seed);
    const rows = await screen.findAllByRole('listitem');
    expect(
      rows.map(
        (row) =>
          within(row).getByText(
            /Older question|About the sync|About a deleted meeting|During a call/,
          ).textContent,
      ),
    ).toEqual(['About the sync', 'About a deleted meeting', 'Older question', 'During a call']);
    const [sync, , older, live] = rows;
    if (!sync || !older || !live) throw new Error('Expected four chats.');
    expect(within(sync).getByText('Weekly sync')).toBeInTheDocument();
    expect(within(older).getByText('Project')).toBeInTheDocument();
    expect(within(live).getByText('Live')).toBeInTheDocument();
  });

  it('badges a chat about a deleted meeting as Meeting deleted, and still lists it', async () => {
    await mount(seed);
    const row = (await screen.findByText('About a deleted meeting')).closest('li') as HTMLElement;
    expect(within(row).getByText('Meeting deleted')).toBeInTheDocument();
  });

  it('opening a chat hands it to the panel with its owner, and does not open anything else', async () => {
    const { user } = await mount(seed);
    await user.click(await screen.findByRole('button', { name: /^About a deleted meeting/ }));
    const request = takeChatRequest();
    expect(request).toMatchObject({ kind: 'open-thread', projectId: OWNER, threadId: guid(103) });
  });

  it('New chat asks the panel for a new chat in this project', async () => {
    const { user } = await mount(seed);
    await user.click(await screen.findByRole('button', { name: 'New chat' }));
    expect(takeChatRequest()).toMatchObject({ kind: 'new-chat', projectId: OWNER });
  });

  it('renames in place from the row menu', async () => {
    const { user, world } = await mount(seed);
    await user.click(await screen.findByRole('button', { name: 'Actions for Older question' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByRole('textbox', { name: 'Rename' });
    await user.clear(field);
    await user.type(field, 'Renamed chat{Enter}');
    await waitFor(() => {
      expect(world.threads.get(OWNER)?.some((t) => t.title === 'Renamed chat')).toBe(true);
    });
    expect(await screen.findByText('Renamed chat')).toBeInTheDocument();
  });

  it('deletes after a confirmation', async () => {
    const { user, world } = await mount(seed);
    await user.click(await screen.findByRole('button', { name: 'Actions for During a call' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(world.threads.get(OWNER)?.map((t) => t.title)).not.toContain('During a call');
    });
  });

  it('says so when a chat could not be deleted, and keeps it listed', async () => {
    const { user, mock } = await mount(seed);
    mock.handle('chat.threads.delete', () => ({ ok: false }));
    await user.click(await screen.findByRole('button', { name: 'Actions for During a call' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The chat was not changed.');
    expect(screen.getByText('During a call')).toBeInTheDocument();
  });

  it('follows the list main keeps: a new chat appears when chat.threads.changed arrives', async () => {
    const { mock, world } = await mount(seed);
    await screen.findByText('Older question');
    world.threads.set(OWNER, [
      ...(world.threads.get(OWNER) ?? []),
      thread(9, 'Fresh chat', { kind: 'Project', meetingId: null }, '2026-06-01T12:00:00.000Z'),
    ]);
    act(() => {
      mock.emit('chat.threads.changed', { projectId: OWNER });
    });
    expect(await screen.findByText('Fresh chat')).toBeInTheDocument();
  });
});
