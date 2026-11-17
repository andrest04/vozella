// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderRouted } from '../../test-support/render-with-router';
import { guid, installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { projectItem } from '../../test-support/project-fixtures';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { ProjectsRoute } from './ProjectsRoute';

afterEach(() => {
  uninstallVozella();
});

async function mount(setup?: (world: ProjectsWorld) => void) {
  const handles = installProjectsWorld(setup);
  const router = await renderRouted('/projects', [
    { path: '/projects', component: ProjectsRoute },
    { path: '/projects/none', component: () => <p>No project page</p> },
    { path: '/projects/$projectId', component: () => <p>A project page</p> },
  ]);
  return { ...handles, router, user: userEvent.setup() };
}

const seed = (world: ProjectsWorld): void => {
  world.projects = [
    projectItem(1, 'Universidad – Cálculo', {
      description: 'Resumir en español, con ejemplos',
      meetingCount: 9,
      lastActivityAt: '2026-03-02T12:00:00.000Z',
      createdAt: '2026-01-01T12:00:00.000Z',
    }),
    projectItem(2, 'Producto Q4', {
      meetingCount: 1,
      lastActivityAt: '2026-05-01T12:00:00.000Z',
      createdAt: '2026-02-01T12:00:00.000Z',
      pinned: true,
    }),
    projectItem(3, 'Álgebra', {
      lastActivityAt: '2026-04-01T12:00:00.000Z',
      createdAt: '2026-03-01T12:00:00.000Z',
    }),
  ];
  world.noProject = { meetingCount: 12, lastActivityAt: '2026-05-04T12:00:00.000Z' };
};

/** The card (article) around an element, which a test cannot do without. */
function cardOf(element: HTMLElement): HTMLElement {
  const card = element.closest('article');
  if (!card) throw new Error('The element is not inside a card.');
  return card;
}

const cards = () =>
  screen.getAllByRole('article').map((card) => within(card).getByRole('link').textContent);

describe('ProjectsRoute', () => {
  it('shows the empty state with its one line and the New project button', async () => {
    await mount();
    expect(
      await screen.findByText('A project keeps related meetings, instructions and files together.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(1);
  });

  it('shows skeleton cards while the list loads', async () => {
    installProjectsWorld();
    window.vozella.invoke = () => new Promise(() => undefined);
    await renderRouted('/projects', [{ path: '/projects', component: ProjectsRoute }]);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('lists the cards under their headings: Pinned first, then All projects, recent activity first', async () => {
    await mount(seed);
    expect(await screen.findByRole('heading', { level: 2, name: 'Pinned' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'All projects' })).toBeInTheDocument();
    expect(cards()).toEqual(['Producto Q4', 'Álgebra', 'Universidad – Cálculo']);
  });

  it('a card carries its description, last activity and meeting count', async () => {
    await mount(seed);
    const link = await screen.findByRole('link', { name: 'Universidad – Cálculo' });
    const card = cardOf(link);
    expect(within(card).getByText('Resumir en español, con ejemplos')).toBeInTheDocument();
    expect(within(card).getByText('2 Mar · 9 meetings')).toBeInTheDocument();
    expect(
      within(cardOf(screen.getByRole('link', { name: 'Producto Q4' }))).getByText(/1 meeting$/),
    ).toBeInTheDocument();
  });

  it('has no button inside a link, and the pin toggle is a named button beside the link', async () => {
    await mount(seed);
    await screen.findAllByRole('article');
    for (const link of screen.getAllByRole('link')) {
      expect(link.querySelector('button')).toBeNull();
    }
    const pin = screen.getByRole('button', { name: 'Pin Producto Q4' });
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pin Álgebra' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Tab order: the name link, then the pin.
    const article = cardOf(pin);
    const focusables = within(article)
      .getAllByRole('link')
      .concat(within(article).getAllByRole('button'));
    expect(focusables.map((el) => el.tagName)).toEqual(['A', 'BUTTON']);
  });

  it('pins and unpins, and the grid follows the answer', async () => {
    const { user, world } = await mount(seed);
    await user.click(await screen.findByRole('button', { name: 'Pin Álgebra' }));
    await waitFor(() => {
      expect(world.details.get(guid(3))?.project.pinned).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pin Álgebra' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('sorts by name and by newest, and keeps the pinned group first', async () => {
    const { user } = await mount(seed);
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('combobox', { name: 'Sort projects' }));
    await user.click(await screen.findByRole('option', { name: 'Name' }));
    expect(cards()).toEqual(['Producto Q4', 'Álgebra', 'Universidad – Cálculo']);
    await user.click(screen.getByRole('combobox', { name: 'Sort projects' }));
    await user.click(await screen.findByRole('option', { name: 'Newest' }));
    expect(cards()).toEqual(['Producto Q4', 'Álgebra', 'Universidad – Cálculo']);
  });

  it('filters by name and description, and offers Clear search when nothing matches', async () => {
    const { user } = await mount(seed);
    await screen.findAllByRole('article');
    await user.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'ejemplos');
    expect(cards()).toEqual(['Universidad – Cálculo']);
    await user.clear(screen.getByRole('searchbox', { name: 'Search projects' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'zzz');
    expect(screen.getByText('No projects match "zzz".')).toBeInTheDocument();
    await user.click(screen.getByText('Clear search', { selector: 'button' }));
    expect(cards()).toHaveLength(3);
  });

  it('shows the No project row only when there are meetings in it, as a link', async () => {
    const { world } = await mount(seed);
    const row = await screen.findByRole('link', { name: /No project/ });
    expect(row).toHaveAttribute('href', '/projects/none');
    expect(row).toHaveTextContent('12 meetings');
    cleanupWorld(world);
  });

  it('leaves the No project row out when there are no unfiled meetings', async () => {
    await mount((world) => {
      seed(world);
      world.noProject = { meetingCount: 0, lastActivityAt: null };
    });
    await screen.findAllByRole('article');
    expect(screen.queryByRole('link', { name: /No project/ })).not.toBeInTheDocument();
  });

  it('reloads when a project changes elsewhere', async () => {
    const { mock, world } = await mount(seed);
    await screen.findAllByRole('article');
    world.projects = [...world.projects, projectItem(9, 'Nuevo desde otra ventana')];
    act(() => {
      mock.emit('projects.changed', { reason: 'project', projectId: guid(9) });
    });
    expect(
      await screen.findByRole('link', { name: 'Nuevo desde otra ventana' }),
    ).toBeInTheDocument();
  });
});

function cleanupWorld(world: ProjectsWorld): void {
  expect(world.projects.length).toBeGreaterThan(0);
}

describe('New project popover', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    return screen.findByRole('dialog', { name: 'New project' });
  };

  it('opens under the button, asks for a name and a description, and Escape closes it with the focus back', async () => {
    const { user } = await mount(seed);
    const trigger = await screen.findByRole('button', { name: 'New project' });
    const dialog = await open(user);
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Description (optional)')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('says a name is needed, in words, without calling main', async () => {
    const { user, mock } = await mount(seed);
    const dialog = await open(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Enter a name for the project.')).toBeInTheDocument();
    expect(mock.inputsOf('projects.create')).toHaveLength(0);
  });

  it('says the name is taken, and keeps the dialog open', async () => {
    const { user } = await mount(seed);
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText('Name'), 'producto q4');
    await user.keyboard('{Enter}');
    expect(
      await within(dialog).findByText('A project with this name already exists.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
  });

  it('creates the project with Enter and opens its page', async () => {
    const { user, world, router } = await mount(seed);
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Marketing');
    await user.type(within(dialog).getByLabelText('Description (optional)'), 'Campañas');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(world.projects.map((p) => p.name)).toContain('Marketing');
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/projects\/0000/);
    });
  });
});

describe('storage states', () => {
  it('says the projects are being prepared and disables New project', async () => {
    await mount((world) => {
      seed(world);
      world.storage = { status: 'migrating' };
    });
    expect(await screen.findByText('Preparing your projects…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('says projects could not be loaded, with the message, and keeps meetings reachable', async () => {
    await mount((world) => {
      seed(world);
      world.storage = { status: 'error', message: 'disk unreadable' };
    });
    const notice = await screen.findByTestId('projects-storage-error');
    expect(notice).toHaveTextContent(
      'Projects could not be loaded. Your meetings are not affected. Restart Vozella to try again.',
    );
    expect(notice).toHaveTextContent('disk unreadable');
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /No project/ })).toBeInTheDocument();
  });

  it('says the library was made by a newer version', async () => {
    await mount((world) => {
      seed(world);
      world.storage = { status: 'newer', found: 3, supported: 1 };
    });
    expect(await screen.findByTestId('projects-storage-newer')).toHaveTextContent(
      'This library was created by a newer version of Vozella. Update to use projects. Your meetings are still available.',
    );
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled();
  });

  it('says how many projects could not be read, and where their meetings are', async () => {
    await mount((world) => {
      seed(world);
      world.skipped = [{ id: null, dir: null, reason: 'corrupt' }];
    });
    expect(
      await screen.findByText('1 project could not be read. Its meetings are under No project.'),
    ).toBeInTheDocument();
  });
});

describe('migration notice', () => {
  const report = (extra: Partial<NonNullable<ProjectsWorld['report']>> = {}) => ({
    kind: 'folders-to-projects' as const,
    projects: 7,
    renamed: [] as { id: string; from: string; to: string }[],
    skipped: [] as { index: number; reason: string }[],
    legacyLeftovers: [] as string[],
    ...extra,
  });

  it('says how many folders became projects and how many were renamed, with the list on demand', async () => {
    const { user } = await mount((world) => {
      seed(world);
      world.report = report({
        renamed: [
          { id: guid(1), from: 'Cálculo', to: 'Universidad – Cálculo' },
          { id: guid(2), from: 'Q4', to: 'Producto Q4' },
        ],
      });
    });
    const notice = await screen.findByTestId('migration-notice');
    expect(notice).toHaveTextContent(
      '7 folders became projects. 2 were renamed to avoid duplicates.',
    );
    await user.click(within(notice).getByText('Show renamed projects'));
    expect(within(notice).getByText('"Cálculo" is now "Universidad – Cálculo"')).toBeVisible();
  });

  it('adds the skipped folders and says their meetings are under No project', async () => {
    await mount((world) => {
      seed(world);
      world.report = report({
        skipped: [
          { index: 1, reason: 'invalid-id' },
          { index: 2, reason: 'duplicate-id' },
          { index: 3, reason: 'invalid-id' },
        ],
      });
    });
    expect(await screen.findByTestId('migration-notice')).toHaveTextContent(
      '3 folders could not be converted because their ids were invalid or repeated. Their meetings are under No project. The original list is saved in the backups folder of your library.',
    );
  });

  it('names the place of an older layout in words, never as a path', async () => {
    await mount((world) => {
      seed(world);
      world.report = report({ legacyLeftovers: ['meetings-folder'] });
    });
    const notice = await screen.findByTestId('migration-notice');
    expect(notice).toHaveTextContent(
      'Meetings from an older layout were found in the old Meetings folder and were not imported.',
    );
    expect(notice.textContent).not.toMatch(/[\\/]/);
  });

  it('is dismissed once, for good', async () => {
    const { user, mock, world } = await mount((w) => {
      seed(w);
      w.report = report();
    });
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('migration-notice')).not.toBeInTheDocument();
    expect(mock.inputsOf('projects.dismissMigrationReport')).toHaveLength(1);
    expect(world.report).toBeNull();
  });
});
