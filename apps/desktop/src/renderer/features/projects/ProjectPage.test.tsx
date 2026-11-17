// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileOf, projectItem, projectOf } from '../../test-support/project-fixtures';
import { guid, installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { renderRouted } from '../../test-support/render-with-router';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { stubLayout } from '../meeting-list/meeting-list-test-kit';
import { ProjectPage } from './ProjectPage';
import { ProjectRoute } from './ProjectRoute';

const ID = guid(1);

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

let isWide = true;
const widthListeners = new Set<() => void>();

/** jsdom has no matchMedia: the page is wide by default, and a test can make it narrow. */
function mockWidth(wide: boolean): void {
  isWide = wide;
  widthListeners.clear();
  const list = (query: string): Partial<MediaQueryList> => ({
    get matches() {
      return isWide && query.includes('min-width: 960px');
    },
    media: query,
    addEventListener: (_type: string, listener: unknown) => {
      widthListeners.add(listener as () => void);
    },
    removeEventListener: (_type: string, listener: unknown) => {
      widthListeners.delete(listener as () => void);
    },
    onchange: null,
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: list,
  });
}

/** Crosses the 960 px breakpoint, as resizing the window does. */
function resizeTo(wide: boolean): void {
  isWide = wide;
  act(() => {
    for (const listener of [...widthListeners]) listener();
  });
}

afterEach(() => {
  uninstallVozella();
  // Back to the jsdom default, which has no matchMedia.
  Reflect.deleteProperty(window, 'matchMedia');
});

const seed = (world: ProjectsWorld): void => {
  world.projects = [
    projectItem(1, 'Universidad – Cálculo', {
      description: 'Weekly lecture notes',
      meetingCount: 12,
    }),
    projectItem(2, 'Producto Q4'),
  ];
  world.details.set(ID, {
    project: projectOf(1, 'Universidad – Cálculo', {
      description: 'Weekly lecture notes',
      instructions: 'Resumir en español.',
    }),
    files: [
      fileOf(1, 'Syllabus.pdf', { kind: 'pdf', pages: 12, sizeBytes: 90_000 }),
      fileOf(2, 'notas.md', { kind: 'text', sizeBytes: 3_000 }),
    ],
  });
};

async function mount(
  setup: (world: ProjectsWorld) => void = seed,
  wide = true,
  path = `/projects/${ID}`,
) {
  mockWidth(wide);
  const handles = installProjectsWorld(setup);
  const router = await renderRouted(path, [
    { path: '/projects', component: () => <p>The projects grid</p> },
    { path: '/projects/$projectId', component: ProjectRoute },
    { path: '/record', component: () => <p>The record page</p> },
  ]);
  const user = userEvent.setup();
  return { ...handles, router, user };
}

const menu = async (user: ReturnType<typeof userEvent.setup>, item: string) => {
  await user.click(await screen.findByRole('button', { name: 'Project actions' }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

describe('the header', () => {
  it('shows the name, the description, a back link and the primary action', async () => {
    await mount();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Universidad – Cálculo' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Weekly lecture notes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(
      screen.getAllByRole('button', { name: 'Start meeting in this project' })[0],
    ).toBeInTheDocument();
  });

  it('Start meeting goes to /record with the project and start parameters', async () => {
    const { user, router } = await mount();
    const [header] = await screen.findAllByRole('button', {
      name: 'Start meeting in this project',
    });
    if (!header) throw new Error('No Start meeting button.');
    await user.click(header);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/record');
    });
    expect(router.state.location.search).toEqual({ project: ID, start: 1 });
  });

  it('renames in place: Enter saves, and the heading shows the new name', async () => {
    const { user, world } = await mount();
    await menu(user, 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Universidad – Cálculo');
    await user.clear(field);
    await user.type(field, 'Cálculo II{Enter}');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cálculo II' }),
    ).toBeInTheDocument();
    expect(world.details.get(ID)?.project.name).toBe('Cálculo II');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('Escape cancels the rename and calls nothing', async () => {
    const { user, mock } = await mount();
    await menu(user, 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Name' });
    await user.type(field, ' extra{Escape}');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Universidad – Cálculo' }),
    ).toBeInTheDocument();
    expect(mock.inputsOf('projects.update')).toHaveLength(0);
  });

  it('leaving the field saves it', async () => {
    const { user, world } = await mount();
    await menu(user, 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'Nuevo nombre');
    await user.tab();
    await waitFor(() => {
      expect(world.details.get(ID)?.project.name).toBe('Nuevo nombre');
    });
  });

  it('says the name is taken where it is typed, and keeps the field open', async () => {
    const { user } = await mount();
    await menu(user, 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'producto q4{Enter}');
    expect(await screen.findByText('A project with this name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('edits the description in place, with Cancel by Escape and save by Enter', async () => {
    const { user, world } = await mount();
    await menu(user, 'Edit description');
    const field = await screen.findByRole('textbox', { name: 'Description' });
    await user.type(field, ' and exam prep');
    await user.keyboard('{Escape}');
    expect(screen.getByText('Weekly lecture notes')).toBeInTheDocument();
    expect(world.details.get(ID)?.project.description).toBe('Weekly lecture notes');
    await menu(user, 'Edit description');
    const again = await screen.findByRole('textbox', { name: 'Description' });
    await user.type(again, ' and exam prep{Enter}');
    expect(await screen.findByText('Weekly lecture notes and exam prep')).toBeInTheDocument();
    expect(world.details.get(ID)?.project.description).toBe('Weekly lecture notes and exam prep');
  });

  it('pins from the menu', async () => {
    const { user, world } = await mount();
    await menu(user, 'Pin');
    await waitFor(() => {
      expect(world.details.get(ID)?.project.pinned).toBe(true);
    });
  });
});

describe('failures that must not pass in silence', () => {
  it('says so when pinning from the menu fails', async () => {
    const { user, mock } = await mount();
    mock.handle('projects.update', () => ({
      ok: false as const,
      reason: 'io-failed' as const,
      message: 'disk is full',
    }));
    await menu(user, 'Pin');
    expect(await screen.findByText('The project was not saved: disk is full')).toBeInTheDocument();
  });
});

describe('tabs', () => {
  it('moves between Meetings and Chats with the arrow keys', async () => {
    const { user } = await mount();
    const meetings = await screen.findByRole('tab', { name: 'Meetings' });
    expect(meetings).toHaveAttribute('aria-selected', 'true');
    meetings.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true');
    expect(
      await screen.findByText("No chats yet. Ask about this project's meetings."),
    ).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Meetings' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says the project has no meetings yet, with the primary action beside it', async () => {
    await mount();
    expect(await screen.findByText('No meetings in this project yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Start meeting in this project' })).toHaveLength(
      2,
    );
  });
});

describe('instructions', () => {
  const panel = () => screen.getByRole('complementary', { name: 'Project details' });

  it('reads as an excerpt of the first six lines, with Show all', async () => {
    const lines = Array.from({ length: 9 }, (_, index) => `Line ${String(index + 1)}`).join('\n');
    const { user } = await mount((world) => {
      seed(world);
      const detail = world.details.get(ID);
      if (detail) detail.project = { ...detail.project, instructions: lines };
    });
    await screen.findByRole('heading', { level: 1 });
    expect(within(panel()).getByText(/Line 6/)).toBeInTheDocument();
    expect(within(panel()).queryByText(/Line 7/)).not.toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Show all' }));
    expect(within(panel()).getByText(/Line 9/)).toBeInTheDocument();
  });

  it('says what instructions are for when there are none', async () => {
    await mount((world) => {
      seed(world);
      const detail = world.details.get(ID);
      if (detail) detail.project = { ...detail.project, instructions: '' };
    });
    expect(
      await screen.findByText('Tell Vozella how to summarize and answer for this project.'),
    ).toBeInTheDocument();
  });

  it('edits in place with a live counter, and Save stores the text', async () => {
    const { user, world } = await mount();
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    const field = within(panel()).getByRole('textbox', { name: 'Instructions' });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(field).toHaveAccessibleDescription('19 of 20,000 characters');
    await user.type(field, ' Con ejemplos.');
    expect(field).toHaveAccessibleDescription('33 of 20,000 characters');
    await user.click(within(panel()).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(world.details.get(ID)?.project.instructions).toBe('Resumir en español. Con ejemplos.');
    });
    expect(within(panel()).getByText('Resumir en español. Con ejemplos.')).toBeInTheDocument();
  });

  it('Ctrl+Enter saves, Escape cancels and gives the focus back to Edit', async () => {
    const { user, world } = await mount();
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    const field = within(panel()).getByRole('textbox', { name: 'Instructions' });
    await user.type(field, ' x{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(world.details.get(ID)?.project.instructions).toBe('Resumir en español. x');
    });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Instructions' }), '{Escape}');
    expect(within(panel()).getByRole('button', { name: 'Edit instructions' })).toHaveFocus();
    expect(world.details.get(ID)?.project.instructions).toBe('Resumir en español. x');
  });

  it('asks before Escape throws away a draft that was changed, and keeps it on Keep editing', async () => {
    const { user, world } = await mount();
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Instructions' }), ' zzz{Escape}');
    const dialog = await screen
      .findByRole('alertdialog', { name: 'Discard your changes?' })
      .catch(() => screen.findByRole('dialog', { name: 'Discard your changes?' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(within(panel()).getByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Resumir en español. zzz',
    );
    await user.type(within(panel()).getByRole('textbox', { name: 'Instructions' }), '{Escape}');
    await user.click(
      within(
        await screen
          .findByRole('alertdialog', { name: 'Discard your changes?' })
          .catch(() => screen.findByRole('dialog', { name: 'Discard your changes?' })),
      ).getByRole('button', { name: 'Discard' }),
    );
    await waitFor(() => {
      expect(
        within(panel()).getByRole('button', { name: 'Edit instructions' }),
      ).toBeInTheDocument();
    });
    expect(world.details.get(ID)?.project.instructions).toBe('Resumir en español.');
  });

  it('counts the characters with the separators of the app language', async () => {
    mockWidth(true);
    installProjectsWorld(seed);
    const user = userEvent.setup();
    await renderRouted(
      `/projects/${ID}`,
      [{ path: '/projects/$projectId', component: ProjectRoute }],
      'es',
    );
    await screen.findByRole('heading', { level: 1 });
    const sidePanel = screen.getByRole('complementary');
    await user.click(within(sidePanel).getByRole('button', { name: 'Editar instrucciones' }));
    expect(
      within(sidePanel).getByRole('textbox', { name: 'Instrucciones' }),
    ).toHaveAccessibleDescription('19 de 20.000 caracteres');
  });

  it('keeps an unsaved draft when the window crosses the 960 px breakpoint', async () => {
    const { user } = await mount();
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Instructions' }), ' draft');
    resizeTo(false);
    const field = await screen.findByRole('textbox', { name: 'Instructions' });
    expect(field).toHaveValue('Resumir en español. draft');
    resizeTo(true);
    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Resumir en español. draft',
    );
  });

  it('Cancel discards the draft', async () => {
    const { user, world } = await mount();
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Instructions' }), 'discard me');
    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    expect(world.details.get(ID)?.project.instructions).toBe('Resumir en español.');
  });

  it('says the limit in words at 20,000 characters', async () => {
    const { user } = await mount((world) => {
      seed(world);
      const detail = world.details.get(ID);
      if (detail) detail.project = { ...detail.project, instructions: 'a'.repeat(20_000) };
    });
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    expect(
      within(panel()).getByText('20,000 of 20,000 characters · Limit reached'),
    ).toBeInTheDocument();
  });

  it('keeps the text and shows the reason when saving fails', async () => {
    const { user, mock } = await mount();
    mock.handle('projects.setInstructions', () => ({
      ok: false as const,
      reason: 'storage-error' as const,
    }));
    await screen.findByRole('heading', { level: 1 });
    await user.click(within(panel()).getByRole('button', { name: 'Edit instructions' }));
    const field = within(panel()).getByRole('textbox', { name: 'Instructions' });
    await user.type(field, ' keep');
    await user.click(within(panel()).getByRole('button', { name: 'Save' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'Projects are unavailable right now',
    );
    expect(within(panel()).getByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Resumir en español. keep',
    );
    // The reason is read with the field, not only announced once.
    expect(
      within(panel()).getByRole('textbox', { name: 'Instructions' }),
    ).toHaveAccessibleDescription(expect.stringContaining('Projects are unavailable right now'));
  });
});

describe('context files', () => {
  const panel = () => screen.getByRole('complementary', { name: 'Project details' });

  it('lists each file with what it is, and a remove button named after it', async () => {
    const { user, world } = await mount();
    expect(await within(panel()).findByText('Syllabus.pdf')).toBeInTheDocument();
    expect(within(panel()).getByText('PDF · 12 pages')).toBeInTheDocument();
    expect(within(panel()).getByText('Text · 3 KB')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Remove notas.md' }));
    await waitFor(() => {
      expect(world.details.get(ID)?.files.map((f) => f.name)).toEqual(['Syllabus.pdf']);
    });
    await waitFor(() => {
      expect(within(panel()).queryByText('notas.md')).not.toBeInTheDocument();
    });
  });

  it('shows a Reading row while the picker answer is pending, then the file', async () => {
    const { user, mock, world } = await mount();
    let release: () => void = () => undefined;
    const added = fileOf(3, 'new.docx', { kind: 'docx', pages: null, sizeBytes: 2_048 });
    mock.handle(
      'projects.files.pick',
      () =>
        new Promise((resolve) => {
          release = () => {
            world.details.get(ID)?.files.push(added);
            resolve({ results: [{ ok: true as const, file: added }] });
          };
        }),
    );
    await within(panel()).findByText('Syllabus.pdf');
    await user.click(within(panel()).getByRole('button', { name: 'Add' }));
    expect(await within(panel()).findByRole('status', { name: 'Reading…' })).toBeInTheDocument();
    act(() => {
      release();
    });
    expect(await within(panel()).findByText('new.docx')).toBeInTheDocument();
    expect(within(panel()).queryByRole('status', { name: 'Reading…' })).not.toBeInTheDocument();
  });

  it.each([
    ['encrypted', 'Encrypted PDF'],
    ['duplicate', 'Duplicate'],
    ['too-large', 'Too large (max 20 MB)'],
    ['project-full', 'Limit of 25 files reached'],
    ['no-text', 'No text found'],
    ['unsupported', 'Not supported'],
  ] as const)('says why a file was refused: %s', async (reason, words) => {
    const { user, world } = await mount();
    world.pickResults = [{ ok: false, name: 'bad.bin', reason }];
    await within(panel()).findByText('Syllabus.pdf');
    await user.click(within(panel()).getByRole('button', { name: 'Add' }));
    expect(await within(panel()).findByText(`bad.bin: ${words}`)).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Dismiss' }));
    expect(within(panel()).queryByText(`bad.bin: ${words}`)).not.toBeInTheDocument();
  });

  it('announces a refused file to a screen reader', async () => {
    const { user, world } = await mount();
    world.pickResults = [{ ok: false, name: 'bad.bin', reason: 'unsupported' }];
    await within(panel()).findByText('Syllabus.pdf');
    await user.click(within(panel()).getByRole('button', { name: 'Add' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('bad.bin: Not supported');
  });

  it('says when a file could not be removed, and keeps it listed', async () => {
    const { user, mock } = await mount();
    mock.handle('projects.files.remove', () => ({ removed: false }));
    await within(panel()).findByText('notas.md');
    await user.click(within(panel()).getByRole('button', { name: 'Remove notas.md' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'notas.md: Could not be removed',
    );
    expect(within(panel()).getByText('notas.md')).toBeInTheDocument();
  });

  it('keeps the good files when one in the batch is refused', async () => {
    const { user, world } = await mount();
    const good = fileOf(4, 'good.pdf', { kind: 'pdf', pages: 2 });
    world.pickResults = [
      { ok: true, file: good },
      { ok: false, name: 'locked.pdf', reason: 'encrypted' },
    ];
    await within(panel()).findByText('Syllabus.pdf');
    await user.click(within(panel()).getByRole('button', { name: 'Add' }));
    expect(await within(panel()).findByText('good.pdf')).toBeInTheDocument();
    expect(within(panel()).getByText('locked.pdf: Encrypted PDF')).toBeInTheDocument();
  });

  it('says what the files are used for, once', async () => {
    await mount();
    expect(
      await screen.findByText(
        'Files are copied into this project and the relevant parts are used when you chat, ask live or summarize.',
      ),
    ).toBeInTheDocument();
  });
});

describe('delete', () => {
  it('asks with the meeting count, and Cancel has the focus', async () => {
    const { user } = await mount();
    await menu(user, 'Delete');
    const dialog = await screen
      .findByRole('alertdialog', { name: 'Delete project?' })
      .catch(() => screen.findByRole('dialog', { name: 'Delete project?' }));
    expect(dialog).toHaveTextContent(
      'Its 12 meetings move to No project. Instructions, files and chats of this project are deleted.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    expect(within(dialog).getByRole('button', { name: 'Delete project' })).toBeInTheDocument();
  });

  it('traps the focus in the dialog', async () => {
    const { user } = await mount();
    await menu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project?' });
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('deletes and goes back to the grid', async () => {
    const { user, router, world } = await mount();
    await menu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete project?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects');
    });
    expect(world.details.has(ID)).toBe(false);
  });

  it('keeps the project and says how far it got, with Try again', async () => {
    const { user, world } = await mount();
    world.deleteResult = { ok: false, reason: 'partial', moved: 9, remaining: 3 };
    await menu(user, 'Delete');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete project?' })).getByRole('button', {
        name: 'Delete project',
      }),
    );
    const notice = await screen.findByText('Moved 9 of 12 meetings. Try again.');
    expect(notice).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Universidad – Cálculo' }),
    ).toBeInTheDocument();
    world.deleteResult = { ok: true };
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(world.details.has(ID)).toBe(false);
    });
  });

  it('says a meeting is still recording or processing when busy', async () => {
    const { user, world } = await mount();
    world.deleteResult = { ok: false, reason: 'busy' };
    await menu(user, 'Delete');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete project?' })).getByRole('button', {
        name: 'Delete project',
      }),
    );
    expect(
      await screen.findByText(
        'A meeting in this project is still recording or processing. Try again when it finishes.',
      ),
    ).toBeInTheDocument();
  });
});

describe('not found', () => {
  it('shows only the frame for an unknown id', async () => {
    await mount(seed, true, `/projects/${guid(77)}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Project not found' }),
    ).toBeInTheDocument();
    expect(screen.getByText('It may have been deleted.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('switches to it when the project is deleted from another window', async () => {
    const { mock, world } = await mount();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Universidad – Cálculo' }),
    ).toBeInTheDocument();
    world.projects = world.projects.filter((p) => p.id !== ID);
    world.details.delete(ID);
    act(() => {
      mock.emit('projects.changed', { reason: 'project', projectId: ID });
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Project not found' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

describe('layout', () => {
  it('puts the instructions and files in a panel beside the content from 960 px', async () => {
    await mount(seed, true);
    const panel = await screen.findByRole('complementary', { name: 'Project details' });
    expect(panel.closest('[data-layout]')).toHaveAttribute('data-layout', 'side');
    expect(document.querySelector('details')).toBeNull();
  });

  it('stacks them as disclosure sections under the header below 960 px', async () => {
    const { user } = await mount(seed, false);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'stacked');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    const details = [...document.querySelectorAll('details')];
    expect(details.map((d) => d.querySelector('summary')?.textContent)).toEqual([
      'Instructions',
      'Context files',
    ]);
    // Collapsed by default, except Instructions when it is empty.
    expect(details.map((d) => d.open)).toEqual([false, false]);
    await user.click(screen.getByText('Context files'));
    expect(document.querySelectorAll('details')[1]?.open).toBe(true);
  });

  it('opens the Instructions section when there are none yet', async () => {
    await mount((world) => {
      seed(world);
      const detail = world.details.get(ID);
      if (detail) detail.project = { ...detail.project, instructions: '' };
    }, false);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelectorAll('details')[0]?.open).toBe(true);
  });
});

describe('ProjectPage is usable without a router param', () => {
  it('renders for an id given as a prop', async () => {
    mockWidth(true);
    installProjectsWorld(seed);
    await renderRouted('/x', [
      { path: '/x', component: () => <ProjectPage projectId={ID} /> },
      { path: '/projects', component: () => <p>grid</p> },
    ]);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Universidad – Cálculo' }),
    ).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
