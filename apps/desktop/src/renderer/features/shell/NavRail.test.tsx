// @vitest-environment jsdom
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Providers } from '../../app/test-providers';
import { NavRail } from './NavRail';
import { NAV, projectIdOfPath, railRouteOf, routeOfTag, tagOfPath } from './navigation';

afterEach(cleanup);

async function mount(initial: string, locale: 'en' | 'es' = 'en') {
  const root = createRootRoute({
    component: () => (
      <Providers locale={locale}>
        <NavRail />
        <Outlet />
      </Providers>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{`page ${path}`}</p> });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/record'),
      page('/projects'),
      page('/projects/$id'),
      page('/library'),
      page('/session'),
      page('/settings'),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

const current = () =>
  screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.id);

describe('navigation shell (items 20 to 28)', () => {
  it('lists Record, Projects, Library and Settings with the automation ids', async () => {
    await mount('/record');
    expect(screen.getAllByRole('link').map((link) => [link.textContent, link.id])).toEqual([
      ['Record', 'NavItemRecording'],
      ['Projects', 'NavItemProjects'],
      ['Library', 'NavItemHistory'],
      ['Settings', 'NavItemSettings'],
    ]);
    expect(screen.getByTestId('NavItemSettings')).toBe(document.getElementById('NavItemSettings'));
    expect(current()).toEqual(['NavItemRecording']);
  });

  it('labels follow the app language, Settings included (item 21)', async () => {
    await mount('/record', 'es');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Grabar',
      'Proyectos',
      'Biblioteca',
      'Configuración',
    ]);
  });

  it('selecting an entry navigates and moves the selection (item 24)', async () => {
    const router = await mount('/record');
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(router.state.location.pathname).toBe('/settings');
    expect(current()).toEqual(['NavItemSettings']);
  });

  it('selecting the page already showing is a no-op (item 25)', async () => {
    const router = await mount('/library');
    const before = router.history.length;
    await userEvent.click(screen.getByRole('link', { name: 'Library' }));
    expect(router.state.location.pathname).toBe('/library');
    expect(router.history.length).toBe(before);
  });

  it.each(['/projects', '/projects/00000000-0000-4000-8000-000000000001', '/projects/none'])(
    'keeps Projects selected on %s',
    async (path) => {
      await mount(path);
      expect(current()).toEqual(['NavItemProjects']);
    },
  );

  it('the rail stays on Library while a session shows, and Library returns to the list (items 26, 27)', async () => {
    const router = await mount('/session');
    expect(current()).toEqual(['NavItemHistory']);
    await userEvent.click(screen.getByRole('link', { name: 'Library' }));
    expect(router.state.location.pathname).toBe('/library');
    expect(screen.getByText('page /library')).toBeTruthy();
  });

  it('a programmatic navigation moves the rail with the page (item 28)', async () => {
    const router = await mount('/record');
    await act(async () => {
      await router.navigate({ to: '/session' });
    });
    expect(current()).toEqual(['NavItemHistory']);
    await act(async () => {
      await router.navigate({ to: '/settings' });
    });
    expect(current()).toEqual(['NavItemSettings']);
  });
});

describe('navigation helpers', () => {
  it('maps tags to routes and back', () => {
    expect(routeOfTag('Recording')).toBe('/record');
    expect(routeOfTag('Session')).toBe('/session');
    expect(tagOfPath('/library')).toBe('History');
    expect(tagOfPath('/gallery')).toBeNull();
  });
  it('tags every /projects route Projects, by prefix', () => {
    expect(routeOfTag('Projects')).toBe('/projects');
    expect(tagOfPath('/projects')).toBe('Projects');
    expect(tagOfPath('/projects/none')).toBe('Projects');
    expect(tagOfPath('/projects/00000000-0000-4000-8000-000000000001')).toBe('Projects');
    expect(tagOfPath('/projectsx')).toBeNull();
    expect(railRouteOf('/projects/none')).toBe('/projects');
    expect(railRouteOf('/projectsx')).toBeNull();
  });
  it('reads the project id from the path', () => {
    expect(projectIdOfPath('/projects/00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(projectIdOfPath('/projects/none')).toBeNull();
    expect(projectIdOfPath('/projects')).toBeNull();
    expect(projectIdOfPath('/library')).toBeNull();
    expect(projectIdOfPath('/projects/a/b')).toBeNull();
  });
  it('Session is not on the rail', () => {
    expect(NAV.map((entry) => entry.to)).not.toContain('/session');
    expect(railRouteOf('/session')).toBe('/library');
    expect(railRouteOf('/gallery')).toBeNull();
  });
});
