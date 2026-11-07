import { useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { cn } from './cn';
import { clampSize, sizeForDrag, sizeForKey, type FixedPane } from './splitter-logic';

export interface SplitterHandleProps {
  /** Current size of the pane the handle resizes. */
  readonly size: number;
  /** Size restored by a double click. */
  readonly defaultSize: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly orientation?: 'horizontal' | 'vertical';
  /** Which side of the handle the resized pane is on. Default `start`. */
  readonly fixedPane?: FixedPane;
  /** Accessible name, for example "Resize navigation pane". */
  readonly label: string;
  /** Id of the resized pane. */
  readonly controls?: string;
  /** Called with a new size; never with the current one. */
  readonly onSizeChange: (size: number) => void;
  /** Positioning of the handle, for example `relative shrink-0` in a flex row. */
  readonly className?: string;
  readonly ref?: Ref<HTMLDivElement>;
}

/**
 * The handle of a splitter (window splitter pattern). Drag it, focus it and use the arrow keys
 * (Shift for bigger steps, Home and End for the limits), or double click to restore the default.
 * It only reports sizes; the owner keeps the size and lays the pane out.
 */
export function SplitterHandle({
  size,
  defaultSize,
  minSize,
  maxSize,
  orientation = 'horizontal',
  fixedPane = 'start',
  label,
  controls,
  onSizeChange,
  className,
  ref,
}: SplitterHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startSize: number; startPointer: number } | null>(null);
  const horizontal = orientation === 'horizontal';

  const update = (next: number): void => {
    if (next !== size) onSizeChange(next);
  };

  const pointerOf = (event: PointerEvent): number => (horizontal ? event.clientX : event.clientY);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = sizeForKey(event.key, event.shiftKey, size, {
      min: minSize,
      max: maxSize,
      orientation,
      fixedPane,
    });
    if (next === null) return;
    event.preventDefault();
    update(next);
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-controls={controls}
      aria-valuenow={size}
      aria-valuemin={minSize}
      aria-valuemax={Math.max(minSize, maxSize)}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        update(clampSize(defaultSize, minSize, maxSize));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startSize: size, startPointer: pointerOf(event) };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        update(
          sizeForDrag(drag.current.startSize, drag.current.startPointer, pointerOf(event), {
            min: minSize,
            max: maxSize,
            fixedPane,
          }),
        );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      className={cn(
        // z-10 keeps the wider hit area on either side of the line above the panes beside it.
        'app-no-drag group z-10 touch-none bg-hairline outline-none',
        horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        'before:absolute before:content-[""]',
        horizontal ? 'before:inset-y-0 before:-inset-x-1' : 'before:inset-x-0 before:-inset-y-1',
        'after:absolute after:bg-ink after:opacity-0 after:transition-opacity after:duration-150 after:content-[""]',
        horizontal ? 'after:inset-y-0 after:-inset-x-px' : 'after:inset-x-0 after:-inset-y-px',
        'hover:after:opacity-100 focus-visible:after:opacity-100 data-dragging:after:opacity-100',
        'forced-colors:bg-[CanvasText]',
        className,
      )}
    />
  );
}
