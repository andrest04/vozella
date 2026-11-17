// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Mic } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Menu,
  Notice,
  RadioGroup,
  Splitter,
  Switch,
  Tabs,
} from '.';

describe('Button and IconButton', () => {
  it('runs its handler and does not when disabled', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Record</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Record
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('gives an icon button its accessible name and hides the glyph', () => {
    render(<IconButton label="Start recording" icon={Mic} tooltip={false} />);
    const button = screen.getByRole('button', { name: 'Start recording' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button.querySelector('svg')).toHaveAttribute('stroke-width', '1.5');
  });
});

describe('Checkbox and Switch', () => {
  it('toggle with Space and are named by their label', async () => {
    render(
      <>
        <Checkbox label="Save the audio" />
        <Switch label="Live transcription" />
      </>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Save the audio' });
    const toggle = screen.getByRole('switch', { name: 'Live transcription' });

    await userEvent.tab();
    expect(checkbox).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(checkbox).toBeChecked();

    await userEvent.tab();
    expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(toggle).toBeChecked();
  });
});

describe('RadioGroup', () => {
  it('moves and selects with the arrow keys', async () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Input"
        value="mic"
        onValueChange={onValueChange}
        options={[
          { value: 'mic', label: 'Microphone' },
          { value: 'system', label: 'System audio' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Input' })).toBeInTheDocument();
    screen.getByRole('radio', { name: 'Microphone' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onValueChange).toHaveBeenCalledWith('system');
  });
});

describe('Tabs', () => {
  it('selects with the arrow keys and shows the matching panel', async () => {
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <Tabs
          label="Views"
          value={value}
          onValueChange={setValue}
          tabs={[
            { value: 'a', label: 'Transcript', content: <p>First panel</p> },
            { value: 'b', label: 'Summary', content: <p>Second panel</p> },
          ]}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeInTheDocument();
    screen.getByRole('tab', { name: 'Transcript' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Second panel')).toBeVisible();
  });

  it('adds the page classes to the tab list and keeps its own', () => {
    const tabs = [{ value: 'a', label: 'Transcript', content: <p>First panel</p> }];
    const view = render(
      <Tabs label="Views" value="a" onValueChange={() => undefined} tabs={tabs} />,
    );
    const plain = screen.getByRole('tablist').className;
    view.unmount();
    render(
      <Tabs
        label="Views"
        value="a"
        onValueChange={() => undefined}
        tabs={tabs}
        listClassName="sticky top-0"
      />,
    );
    expect(screen.getByRole('tablist').className).toBe(`${plain} sticky top-0`);
  });
});

describe('Menu', () => {
  it('opens from the keyboard, skips separators and runs the chosen entry', async () => {
    const onRename = vi.fn();
    render(
      <Menu
        trigger={<Button>Actions</Button>}
        entries={[
          { id: 'rename', label: 'Rename', onSelect: onRename },
          { id: 'sep', kind: 'separator' },
          { id: 'delete', label: 'Delete', onSelect: () => undefined },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    // Opening with the keyboard lands on the first entry; the separator is skipped.
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledTimes(1);
  });
});

describe('Dialog', () => {
  it('is named by its title, and Escape asks to close', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Delete this meeting?"
        description="This cannot be undone."
        closeLabel="Close"
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete this meeting?' });
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it('is 30rem wide by default and 40rem when wide', async () => {
    const { rerender } = render(
      <Dialog open onOpenChange={() => undefined} title="Models" closeLabel="Close" />,
    );
    expect(await screen.findByRole('dialog', { name: 'Models' })).toHaveClass(
      'w-[min(30rem,calc(100vw-2rem))]',
    );
    rerender(
      <Dialog open onOpenChange={() => undefined} title="Models" closeLabel="Close" size="wide" />,
    );
    expect(screen.getByRole('dialog', { name: 'Models' })).toHaveClass(
      'w-[min(40rem,calc(100vw-2rem))]',
    );
  });
});

describe('Splitter', () => {
  // jsdom has no pointer capture; Electron does.
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;

  it('exposes its value and resizes with the keyboard, restoring on double click', async () => {
    const onSizeChange = vi.fn();
    render(
      <Splitter
        label="Resize navigation pane"
        defaultSize={200}
        minSize={100}
        maxSize={300}
        onSizeChange={onSizeChange}
        first={<div>one</div>}
        second={<div>two</div>}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize navigation pane' });
    expect(handle).toHaveAttribute('aria-valuenow', '200');
    expect(handle).toHaveAttribute('aria-valuemin', '100');
    expect(handle).toHaveAttribute('aria-valuemax', '300');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '216');
    await userEvent.keyboard('{End}');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    await userEvent.dblClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', '200');
    expect(onSizeChange).toHaveBeenLastCalledWith(200);
  });
});

describe('Notice', () => {
  it('speaks politely, and closes only when it was given a way to', async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Notice>Saved elsewhere</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved elsewhere');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <Notice onDismiss={onDismiss} dismissLabel="Close">
        Saved elsewhere
      </Notice>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
