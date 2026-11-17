import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

export interface DisclosureProps {
  /** The visible name of the section; it is also what the toggle is called. */
  readonly title: string;
  readonly children: ReactNode;
  /** Open on first render. The state is the section's own afterwards. */
  readonly defaultOpen?: boolean;
  readonly className?: string;
  /** Automation id of the section. */
  readonly testId?: string;
}

/**
 * A section the reader can fold: the native details and summary, so the keyboard, the state and
 * the announcement are the platform's. The chevron turns in 150 ms; reduced motion removes it.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
  testId,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <details
      open={open}
      data-testid={testId}
      className={cn('group border-b border-hairline', className)}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary
        aria-controls={panelId}
        className={cn(
          'flex min-h-10 cursor-default list-none items-center gap-2 rounded-control text-ui-lg font-medium text-ink select-none',
          '[&::-webkit-details-marker]:hidden hover:bg-hover active:bg-pressed',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        )}
      >
        <Icon
          icon={ChevronRight}
          size={14}
          className="text-ink-muted transition-transform duration-150 ease-out-quick group-open:rotate-90 motion-reduce:transition-none"
        />
        {title}
      </summary>
      <div id={panelId} className="pb-4 ps-6">
        {children}
      </div>
    </details>
  );
}
