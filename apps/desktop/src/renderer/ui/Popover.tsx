import { Popover as BasePopover } from '@base-ui/react/popover';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { cn } from './cn';
import { popupColors, popupSurface } from './styles';
import { Tooltip } from './Tooltip';

export interface PopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The button that opens the popover. It must accept a ref and props. */
  readonly trigger: ReactElement;
  /** Accessible name of the popup (a dialog). */
  readonly label: string;
  /** Tooltip on the trigger, for a trigger whose text may be cut short. */
  readonly tooltip?: ReactNode;
  readonly children: ReactNode;
  readonly side?: 'top' | 'bottom';
  readonly align?: 'start' | 'center' | 'end';
  /** Where focus goes when it opens. Default: the first focusable element inside. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly className?: string;
}

/**
 * A non-modal panel anchored to its trigger: raised paper, hairline edge, the overlay shadow, a
 * 150 ms fade with a 4 px rise. Escape and a press outside close it; focus goes back to the trigger.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  tooltip,
  children,
  side = 'bottom',
  align = 'start',
  initialFocus,
  className,
}: PopoverProps) {
  return (
    <BasePopover.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      {tooltip ? (
        <Tooltip content={tooltip}>
          <BasePopover.Trigger render={trigger} />
        </Tooltip>
      ) : (
        <BasePopover.Trigger render={trigger} />
      )}
      <BasePopover.Portal>
        {/* z-50 like menus: a floating AI panel (z-30) must not cover its own popups. */}
        <BasePopover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
        >
          <BasePopover.Popup
            aria-label={label}
            {...(initialFocus ? { initialFocus } : {})}
            className={cn(popupSurface, popupColors, className)}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
