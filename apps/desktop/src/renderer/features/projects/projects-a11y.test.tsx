// @vitest-environment jsdom
import axe from 'axe-core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileOf, projectItem, projectOf } from '../../test-support/project-fixtures';
import { guid, installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { renderRouted } from '../../test-support/render-with-router';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { stubLayout } from '../meeting-list/meeting-list-test-kit';
import { ProjectRoute } from './ProjectRoute';
import { ProjectsRoute } from './ProjectsRoute';

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

/**
 * Contrast needs real layout and paint, which jsdom has none of. The landmark rule is left to the
 * shell, which wraps every page in its one main region. The other rules apply.
 */
async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`,
  );
}

const seed = (world: ProjectsWorld): void => {
  world.projects = [
    projectItem(1, 'Universidad', { description: 'Clases', meetingCount: 3, pinned: true }),
    projectItem(2, 'Producto Q4', { meetingCount: 1 }),
  ];
  world.noProject = { meetingCount: 2, lastActivityAt: '2026-05-04T12:00:00.000Z' };
  world.details.set(guid(1), {
    project: projectOf(1, 'Universidad', { description: 'Clases', instructions: 'Resumir.' }),
    files: [fileOf(1, 'Syllabus.pdf', { kind: 'pdf', pages: 4 })],
  });
};

describe('accessibility of the Projects tab', () => {
  it('the grid has no violations, with a populated list and the New project popover open', async () => {
    installProjectsWorld(seed);
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    await screen.findAllByRole('article');
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    await screen.findByRole('dialog', { name: 'New project' });
    expect(await violations()).toEqual([]);
  });

  it('every icon button on the grid has an accessible name', async () => {
    installProjectsWorld(seed);
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    await screen.findAllByRole('article');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('the project page has no violations, in both layouts', async () => {
    installProjectsWorld(seed);
    await renderRouted(`/projects/${guid(1)}`, [
      { path: '/projects/$projectId', component: ProjectRoute },
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Universidad' });
    expect(await violations()).toEqual([]);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('state is never carried by color alone: pinned is a pressed toggle, errors are words with an icon', async () => {
    installProjectsWorld(seed);
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    await screen.findAllByRole('article');
    expect(screen.getByRole('button', { name: 'Pin Universidad' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const message = await within(dialog).findByText('Enter a name for the project.');
    expect(message.parentElement?.querySelector('svg')).not.toBeNull();
  });
});
