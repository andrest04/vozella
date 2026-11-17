// @vitest-environment jsdom
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectProjectDirectory } from '../meeting-list/project-directory';
import { guid, projectItem } from '../../test-support/project-fixtures';
import { installVozella, uninstallVozella } from '../../test-support/vozella-mock';
import { useSelectedProjectPublisher } from './use-selected-project';

afterEach(() => {
  cleanup();
  uninstallVozella();
});

function Shell() {
  useSelectedProjectPublisher();
  return <Outlet />;
}

async function mount(initial: string, projectIds: number[]) {
  const mock = installVozella({
    'projects.list': () => ({
      projects: projectIds.map((n) => projectItem(n, `P${String(n)}`)),
      noProject: { meetingCount: 0, lastActivityAt: null },
      skipped: [],
      storage: { status: 'ready' as const },
    }),
    'workspace.dispatch': () => ({ state: {} as never }),
  });
  const off = connectProjectDirectory();
  const root = createRootRoute({ component: Shell });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{path}</p> });
  const router = createRouter({
    routeTree: root.addChildren([page('/projects'), page('/projects/$id'), page('/record')]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  // The list was asked for; let its answer and the publish that follows run their course.
  await vi.waitFor(() => {
    expect(mock.inputsOf('projects.list').length).toBeGreaterThan(0);
  });
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
  return { mock, router, off };
}

const published = (mock: ReturnType<typeof installVozella>) =>
  mock
    .inputsOf('workspace.dispatch')
    .map((input) => (input as { action: { projectId?: string | null } }).action.projectId);

describe('selected project publishing', () => {
  it('publishes the id once the project on /projects/<id> resolves', async () => {
    const { mock, off } = await mount(`/projects/${guid(1)}`, [1]);
    expect(published(mock).at(-1)).toBe(guid(1));
    off();
  });

  it('publishes null for an unknown id, the grid, No project and other routes', async () => {
    for (const path of [`/projects/${guid(9)}`, '/projects', '/projects/none', '/record']) {
      const { mock, off } = await mount(path, [1]);
      expect(published(mock).at(-1)).toBeNull();
      off();
      cleanup();
    }
  });

  it('publishes null when leaving the project page', async () => {
    const { mock, router, off } = await mount(`/projects/${guid(1)}`, [1]);
    await act(async () => {
      await router.navigate({ to: '/record' });
    });
    expect(published(mock).at(-1)).toBeNull();
    off();
  });
});
