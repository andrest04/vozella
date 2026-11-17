import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Providers } from '../app/test-providers';
import { ToastProvider } from '../ui';

export interface RoutedPage {
  readonly path: string;
  readonly component: () => ReactNode;
}

/**
 * Mounts pages in a memory router under the app providers, at `initial`. A path such as
 * `/projects/$projectId` is a route pattern; every page also gets the toast host.
 */
export async function renderRouted(
  initial: string,
  pages: readonly RoutedPage[],
  locale: 'en' | 'es' = 'en',
) {
  const root = createRootRoute({
    component: () => (
      <Providers locale={locale}>
        <ToastProvider dismissLabel="Dismiss">
          <Outlet />
        </ToastProvider>
      </Providers>
    ),
  });
  const routes = pages.map((page) =>
    createRoute({ getParentRoute: () => root, path: page.path, component: page.component }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}
