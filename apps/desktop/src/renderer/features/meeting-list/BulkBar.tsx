import { Trash, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, IconButton } from '../../ui';

export interface BulkBarProps {
  readonly label: string;
  /** "Checked: 3", or the work under way. */
  readonly status: string;
  readonly busy: boolean;
  /** The Move to project control: a popover trigger the list owns, disabled with the bar. */
  readonly move: ReactNode;
  readonly deleteLabel: string;
  readonly clearLabel: string;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}

/** What can be done to the checked meetings. It holds its actions while one is running. */
export function BulkBar({
  label,
  status,
  busy,
  move,
  deleteLabel,
  clearLabel,
  onDelete,
  onClear,
}: BulkBarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-busy={busy}
      className="flex h-10 shrink-0 items-center gap-1 border-y border-hairline ps-4 pe-1.5"
    >
      <span role="status" className="tabular min-w-0 flex-1 truncate text-ui text-ink">
        {status}
      </span>
      {move}
      <Button size="sm" variant="quiet" icon={Trash} disabled={busy} onClick={onDelete}>
        {deleteLabel}
      </Button>
      <IconButton label={clearLabel} icon={X} size="sm" disabled={busy} onClick={onClear} />
    </div>
  );
}
