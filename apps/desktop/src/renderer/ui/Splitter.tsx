import { useId, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { SplitterHandle } from './SplitterHandle';
import { clampSize, type FixedPane } from './splitter-logic';

export interface SplitterProps {
  /** First pane (left, or top when vertical). */
  readonly first: ReactNode;
  /** Second pane (right, or bottom when vertical). */
  readonly second: ReactNode;
  /** Which pane keeps the fixed size; the other one takes the rest. Default `start` (the first). */
  readonly fixedPane?: FixedPane;
  /** Size restored by a double click on the handle. */
  readonly defaultSize: number;
  /** Size at mount, for example a remembered one. Defaults to `defaultSize`. */
  readonly initialSize?: number;
  /**
   * Size of the fixed pane, when the owner keeps it (controlled). Without it the splitter keeps
   * its own size, starting from `initialSize`.
   */
  readonly size?: number;
  /**
   * The fixed pane leaves the layout: no handle and no size. Its content stays mounted and
   * decides itself whether to hide or float, so the other pane never remounts.
   */
  readonly collapsed?: boolean;
  readonly minSize: number;
  readonly maxSize: number;
  readonly orientation?: 'horizontal' | 'vertical';
  /** Accessible name of the handle, for example "Resize navigation pane". */
  readonly label: string;
  readonly onSizeChange?: (size: number) => void;
  readonly className?: string;
}

/**
 * Two panes and a handle. Drag it, focus it and use the arrow keys (Shift for bigger steps,
 * Home and End for the limits), or double click to restore the default size.
 */
export function Splitter({
  first,
  second,
  fixedPane = 'start',
  defaultSize,
  initialSize,
  size: controlledSize,
  collapsed = false,
  minSize,
  maxSize,
  orientation = 'horizontal',
  label,
  onSizeChange,
  className,
}: SplitterProps) {
  const fixedId = useId();
  const [ownSize, setOwnSize] = useState(() =>
    clampSize(initialSize ?? defaultSize, minSize, maxSize),
  );
  const size = controlledSize === undefined ? ownSize : clampSize(controlledSize, minSize, maxSize);
  const horizontal = orientation === 'horizontal';

  const fixed = (content: ReactNode): ReactNode => (
    <div
      id={fixedId}
      style={collapsed ? undefined : horizontal ? { width: size } : { height: size }}
      className={collapsed ? 'contents' : 'flex min-h-0 min-w-0 shrink-0 flex-col'}
    >
      {content}
    </div>
  );
  const fluid = (content: ReactNode): ReactNode => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
  );

  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-1', horizontal ? 'flex-row' : 'flex-col', className)}
    >
      {fixedPane === 'start' ? fixed(first) : fluid(first)}
      {collapsed ? null : (
        <SplitterHandle
          size={size}
          defaultSize={defaultSize}
          minSize={minSize}
          maxSize={maxSize}
          orientation={orientation}
          fixedPane={fixedPane}
          label={label}
          controls={fixedId}
          onSizeChange={(next) => {
            setOwnSize(next);
            onSizeChange?.(next);
          }}
          className="relative shrink-0"
        />
      )}
      {fixedPane === 'start' ? fluid(second) : fixed(second)}
    </div>
  );
}
