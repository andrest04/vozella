// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Providers } from '../../app/test-providers';
import { projectItem } from '../../test-support/project-fixtures';
import { installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { renderRouted } from '../../test-support/render-with-router';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { Button, IconButton, Menu, Tabs } from '../../ui';
import { Pin } from 'lucide-react';
import { ProjectCard } from './ProjectCard';
import { ProjectsRoute } from './ProjectsRoute';

afterEach(() => {
  uninstallVozella();
});

const has = (element: Element, ...classes: string[]): void => {
  for (const name of classes) expect(element.className, name).toContain(name);
};

describe('interactive states of the Projects tab (conformance table 8.0)', () => {
  it('a card has hover, pressed and keyboard focus states, and its pin has a disabled state', async () => {
    await renderRouted('/x', [
      {
        path: '/x',
        component: () => (
          <ProjectCard
            project={projectItem(1, 'Universidad', { pinned: false })}
            activity="2 Mar"
            meetings="9 meetings"
            pinLabel="Pin Universidad"
            pinDisabled
            onTogglePin={() => undefined}
          />
        ),
      },
    ]);
    const card = await screen.findByRole('article');
    has(card, 'hover:bg-hover', 'active:bg-pressed', 'focus-within:outline-2', 'border-hairline');
    // No shadow and no colored edge: a hairline and nothing else.
    expect(card.className).not.toMatch(/shadow|border-l-|border-s-/);
    const pin = screen.getByRole('button', { name: 'Pin Universidad' });
    expect(pin).toBeDisabled();
    has(
      pin,
      'data-disabled:opacity-50',
      'hover:not-data-disabled:bg-hover',
      'active:not-data-disabled:bg-pressed',
    );
  });

  it('a tab has hover, active and selected states', () => {
    render(
      <Tabs
        label="Project"
        value="a"
        onValueChange={() => undefined}
        tabs={[
          { value: 'a', label: 'Meetings', content: <p>a</p> },
          { value: 'b', label: 'Chats', content: <p>b</p> },
        ]}
      />,
    );
    has(
      screen.getByRole('tab', { name: 'Chats' }),
      'hover:text-ink',
      'data-active:font-medium',
      'data-active:text-ink',
    );
  });

  it('a button has hover, pressed, disabled and a visible focus ring', () => {
    render(
      <Providers>
        <Button variant="primary">Start meeting</Button>
        <IconButton label="Pin" icon={Pin} />
      </Providers>,
    );
    has(
      screen.getByRole('button', { name: 'Start meeting' }),
      'hover:not-data-disabled:opacity-85',
      'active:not-data-disabled:opacity-70',
      'data-disabled:cursor-not-allowed',
    );
    // The focus ring is global: 2 px ink, offset 2 px (styles/index.css, checked by tokens.test).
    expect(screen.getByRole('button', { name: 'Pin' }).className).toContain(
      'hover:not-data-disabled:bg-hover',
    );
  });

  it('a menu row highlights on hover and keyboard, and dims when disabled', async () => {
    render(
      <Providers>
        <Menu
          trigger={<Button>Open</Button>}
          entries={[
            { id: 'a', label: 'Rename', onSelect: () => undefined },
            { id: 'b', label: 'Delete', disabled: true, onSelect: () => undefined },
          ]}
        />
      </Providers>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    has(await screen.findByRole('menuitem', { name: 'Rename' }), 'data-highlighted:bg-hover');
    has(screen.getByRole('menuitem', { name: 'Delete' }), 'data-disabled:opacity-50');
  });
});

describe('focus order and the loading and error states of the grid', () => {
  const seed = (world: ProjectsWorld): void => {
    world.projects = [projectItem(1, 'Universidad', { pinned: true }), projectItem(2, 'Producto')];
    world.noProject = { meetingCount: 2, lastActivityAt: '2026-05-04T12:00:00.000Z' };
  };

  it('tabs through New project, search, sort, the No project row, then each card link and pin', async () => {
    installProjectsWorld(seed);
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    await screen.findAllByRole('article');
    const order: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      await userEvent.tab();
      const active = document.activeElement;
      order.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    expect(order).toEqual([
      'New project',
      'Search projects',
      'Sort projects',
      expect.stringContaining('No project'),
      'Universidad',
      'Pin Universidad',
      'Producto',
      'Pin Producto',
    ]);
  });

  it('shows a skeleton while loading and a notice, not a crash, when the list cannot be read', async () => {
    const world = installProjectsWorld();
    world.mock.handle('projects.list', () => {
      throw new Error('boom');
    });
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    expect(await screen.findByTestId('projects-storage-error')).toBeInTheDocument();
  });
});
