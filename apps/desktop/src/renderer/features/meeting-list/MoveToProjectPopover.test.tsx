// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/test-providers';
import { guid, installProjectsWorld, type ProjectsWorld } from '../../test-support/projects-world';
import { projectItem } from '../../test-support/project-fixtures';
import { uninstallVozella } from '../../test-support/vozella-mock';
import { Button } from '../../ui';
import { MoveToProjectPopover } from './MoveToProjectPopover';

afterEach(() => {
  uninstallVozella();
});

const seed = (world: ProjectsWorld): void => {
  world.projects = [
    projectItem(1, 'Universidad'),
    projectItem(2, 'Álgebra'),
    projectItem(3, 'Mercadeo', { pinned: true }),
  ];
};

function Host({
  from,
  onMove,
}: {
  from: readonly (string | null)[];
  onMove: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Providers>
      <MoveToProjectPopover
        open={open}
        onOpenChange={setOpen}
        from={from}
        onMove={onMove}
        trigger={<Button>Open mover</Button>}
      />
    </Providers>
  );
}

async function mount(
  from: readonly (string | null)[],
  setup: (world: ProjectsWorld) => void = seed,
) {
  installProjectsWorld(setup);
  const onMove = vi.fn();
  const user = userEvent.setup();
  render(<Host from={from} onMove={onMove} />);
  const trigger = screen.getByRole('button', { name: 'Open mover' });
  await user.click(trigger);
  const popover = await screen.findByRole('dialog', { name: 'Move to project' });
  return { user, onMove, trigger, popover };
}

const labels = (popover: HTMLElement) =>
  within(popover)
    .getAllByRole('option')
    .map((option) => option.textContent);

describe('MoveToProjectPopover', () => {
  it('lists the pinned projects first, then the others by name, flat', async () => {
    const { popover } = await mount([null]);
    await waitFor(() => {
      expect(labels(popover)).toEqual(['Mercadeo', 'Álgebra', 'Universidad']);
    });
  });

  it('offers No project first for a meeting that is in a project, and not that project', async () => {
    const { popover } = await mount([guid(1)]);
    await waitFor(() => {
      expect(labels(popover)).toEqual(['No project', 'Mercadeo', 'Álgebra']);
    });
  });

  it('puts the focus in the search field, and typing filters by folded words', async () => {
    const { user, popover } = await mount([null]);
    const field = within(popover).getByRole('combobox', { name: 'Search projects' });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    await user.type(field, 'ALGEB');
    expect(labels(popover)).toEqual(['Álgebra']);
    await user.clear(field);
    await user.type(field, 'zzz');
    expect(within(popover).getByText('No project matches.')).toBeInTheDocument();
  });

  it('points aria-controls at a list only while the list is on screen', async () => {
    const { user, popover } = await mount([null]);
    const field = within(popover).getByRole('combobox', { name: 'Search projects' });
    await waitFor(() => {
      expect(within(popover).getAllByRole('listbox')).toHaveLength(1);
    });
    expect(field).toHaveAttribute('aria-controls', within(popover).getByRole('listbox').id);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    await user.type(field, 'zzz');
    // No list, so nothing to control: a reference to a missing id is an invalid ARIA value.
    expect(within(popover).queryByRole('listbox')).toBeNull();
    expect(field).not.toHaveAttribute('aria-controls');
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves with the arrows and Enter, keeping the focus in the field', async () => {
    const { user, popover, onMove } = await mount([null]);
    const field = within(popover).getByRole('combobox', { name: 'Search projects' });
    await waitFor(() => {
      expect(within(popover).getAllByRole('option')).toHaveLength(3);
    });
    expect(field).toHaveAttribute(
      'aria-activedescendant',
      within(popover).getAllByRole('option')[0]?.id,
    );
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(within(popover).getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveFocus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onMove).toHaveBeenCalledWith(guid(2));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Move to project' })).not.toBeInTheDocument();
    });
  });

  it('a click on a place moves, and No project moves to null', async () => {
    const { user, popover, onMove } = await mount([guid(1)]);
    await user.click(await within(popover).findByRole('option', { name: 'No project' }));
    expect(onMove).toHaveBeenCalledWith(null);
  });

  it('Escape closes it and the focus returns to the button that opened it', async () => {
    const { user, trigger, onMove } = await mount([null]);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Move to project' })).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('says projects are unavailable when storage is not ready, and offers nothing to pick', async () => {
    const { popover } = await mount([null], (world) => {
      seed(world);
      world.storage = { status: 'error', message: 'x' };
    });
    expect(
      await within(popover).findByText(/Projects are unavailable right now/),
    ).toBeInTheDocument();
    expect(within(popover).queryByRole('option')).not.toBeInTheDocument();
  });
});
