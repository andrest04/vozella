// @vitest-environment jsdom
import type { MeetingListItemDto } from '@vozella/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { projectItem } from '../../test-support/project-fixtures';
import { installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { renderRouted } from '../../test-support/render-with-router';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { stubLayout } from '../meeting-list/meeting-list-test-kit';
import { NoProjectRoute } from './NoProjectRoute';

beforeAll(() => {
  class FakeResizeObserver {
    observe(): void {
      // jsdom has no layout to observe.
    }
    disconnect(): void {
      // Nothing was observed.
    }
    unobserve(): void {
      // Nothing was observed.
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver;
  stubLayout();
});

afterEach(() => {
  uninstallVozella();
});

const meeting = (
  id: string,
  title: string,
  day: string,
  projectId: string | null,
): MeetingListItemDto => ({
  id,
  title,
  recordedAt: `2026-09-${day}T09:00:00.0000000+00:00`,
  endedAt: null,
  projectId,
  snippet: '',
  hasSummary: false,
  hasTranscript: false,
  busy: false,
});

async function mount(setup: (world: ProjectsWorld) => void) {
  const handles = installProjectsWorld((world) => {
    world.projects = [projectItem(1, 'Universidad'), projectItem(2, 'Mercadeo')];
    setup(world);
  });
  handles.mock.handle('library.moveMeeting', ({ meetingId, projectId }) => {
    handles.world.meetings = handles.world.meetings.map((m) =>
      m.id === meetingId ? { ...m, projectId } : m,
    );
    return { ok: true as const };
  });
  handles.mock.handle('library.moveMeetings', ({ meetingIds, projectId }) => {
    handles.world.meetings = handles.world.meetings.map((m) =>
      meetingIds.includes(m.id) ? { ...m, projectId } : m,
    );
    return { results: meetingIds.map((meetingId) => ({ meetingId, ok: true as const })) };
  });
  await renderRouted('/projects/none', [
    { path: '/projects', component: () => <p>grid</p> },
    { path: '/projects/none', component: NoProjectRoute },
  ]);
  return { ...handles, user: userEvent.setup() };
}

describe('NoProjectRoute', () => {
  it('has the frame without a right panel or a Start meeting button', async () => {
    await mount(() => undefined);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No project' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Meetings that are not in a project')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Meetings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start meeting/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
  });

  it('says every meeting is in a project when there are none left', async () => {
    await mount((world) => {
      world.meetings = [meeting('a', 'Planning', '03', '00000000-0000-4000-8000-000000000001')];
    });
    expect(await screen.findByText('Every meeting is in a project.')).toBeInTheDocument();
  });

  it('lists only the meetings in no project, and moves one to a project from its row menu', async () => {
    const { user, world } = await mount((w) => {
      w.meetings = [
        meeting('a', 'Standup', '01', null),
        meeting('b', 'Planning', '03', '00000000-0000-4000-8000-000000000001'),
        meeting('c', 'Review', '02', 'gone'),
      ];
    });
    const standup = await screen.findByRole('row', { name: /Standup/ });
    expect(screen.getByRole('row', { name: /Review/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Planning/ })).not.toBeInTheDocument();
    await user.click(within(standup).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to project' }));
    const popover = await screen.findByRole('dialog', { name: 'Move to project' });
    await user.click(await within(popover).findByRole('option', { name: 'Mercadeo' }));
    await waitFor(() => {
      expect(world.meetings.find((m) => m.id === 'a')?.projectId).toBe(
        '00000000-0000-4000-8000-000000000002',
      );
    });
  });

  it('moves the checked meetings together from the bar', async () => {
    const { user, world } = await mount((w) => {
      w.meetings = [meeting('a', 'Standup', '01', null), meeting('c', 'Review', '02', null)];
    });
    await user.click(
      within(await screen.findByRole('row', { name: /Standup/ })).getByRole('checkbox', {
        name: /Select/,
      }),
    );
    await user.click(
      within(screen.getByRole('row', { name: /Review/ })).getByRole('checkbox', { name: /Select/ }),
    );
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Checked meetings' })).getByRole('button', {
        name: 'Move to project',
      }),
    );
    const popover = await screen.findByRole('dialog', { name: 'Move to project' });
    await user.click(await within(popover).findByRole('option', { name: 'Universidad' }));
    await waitFor(() => {
      expect(world.meetings.map((m) => m.projectId)).toEqual([
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
      ]);
    });
  });
});
