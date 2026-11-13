import { Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, KeyRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn, Icon } from '../../ui';
import { ProviderMark } from '../ai-provider/ProviderMark';
import type { EngineKind, EngineStatus } from './engine-status';

/** Status carries meaning by words and a glyph, never by color. */
const STATUS_ICONS: Readonly<Record<EngineStatus, LucideIcon>> = {
  'in-use': Check,
  ready: CircleCheck,
  'key-saved': KeyRound,
  'not-found': CircleAlert,
  'needs-key': CircleDashed,
  'not-set-up': CircleDashed,
};

export interface EngineRowView {
  readonly kind: EngineKind;
  readonly name: string;
  readonly status: EngineStatus | null;
  /** The status in words. */
  readonly statusText: string;
  /** Shown only for the engine in use. */
  readonly model: string | null;
}

export interface EngineGroupView {
  readonly caption: string;
  readonly rows: readonly EngineRowView[];
}

function EngineRow({
  row,
  open,
  onToggle,
  children,
}: {
  readonly row: EngineRowView;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const id = useId();
  const nameId = `${id}-name`;
  const modelId = `${id}-model`;
  const statusId = `${id}-status`;
  const panelId = `${id}-panel`;
  const inUse = row.status === 'in-use';
  const describedBy = [row.model ? modelId : null, row.status ? statusId : null]
    .filter((part): part is string => part !== null)
    .join(' ');

  // The row is named by its visible engine name (WCAG 2.5.3, label in name). The model and status
  // are hidden from that name and read as the description instead, so the name stays the engine.
  return (
    <li className="border-b border-hairline py-1 last:border-b-0">
      <button
        type="button"
        data-engine={row.kind}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onClick={onToggle}
        className={cn(
          'flex min-h-10 w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-start',
          'transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed',
          open && 'bg-hover',
        )}
      >
        <ProviderMark kind={row.kind} />
        <span id={nameId} className="shrink-0 text-ui-lg text-ink">
          {row.name}
        </span>
        {row.model ? (
          <span id={modelId} aria-hidden="true" className="min-w-0 truncate text-ui text-ink-muted">
            {row.model}
          </span>
        ) : null}
        {row.status ? (
          <span
            id={statusId}
            aria-hidden="true"
            className={cn(
              'ms-auto flex shrink-0 items-center gap-1.5 text-ui',
              inUse ? 'font-medium text-ink' : 'text-ink-muted',
            )}
          >
            <Icon icon={STATUS_ICONS[row.status]} size={14} />
            {row.statusText}
          </span>
        ) : (
          <span className="ms-auto" />
        )}
        <Icon
          icon={ChevronDown}
          size={16}
          className={cn(
            'text-ink-faint transition-transform duration-150 ease-out-quick motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={nameId}
          className="animate-fade-in ps-9 pe-2.5 pt-1 pb-3"
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Every summary engine as a row under its group caption: mark, name, the model of the engine in
 * use, and a short status. A row is a disclosure: it opens its setup right beneath it and never
 * changes the engine in use. One row is open at a time; the caller owns which and what it holds.
 */
export function EngineList({
  label,
  groups,
  openKind,
  onToggle,
  renderPanel,
}: {
  readonly label: string;
  readonly groups: readonly EngineGroupView[];
  readonly openKind: EngineKind | null;
  readonly onToggle: (kind: EngineKind) => void;
  readonly renderPanel: (kind: EngineKind) => ReactNode;
}): ReactNode {
  const baseId = useId();
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-4">
      {groups.map((group, index) => {
        const captionId = `${baseId}-group-${String(index)}`;
        return (
          <div key={group.caption} className="flex flex-col gap-1">
            <span id={captionId} className="px-2.5 text-ui text-ink-muted">
              {group.caption}
            </span>
            <ul aria-labelledby={captionId} className="flex flex-col">
              {group.rows.map((row) => (
                <EngineRow
                  key={row.kind}
                  row={row}
                  open={openKind === row.kind}
                  onToggle={() => {
                    onToggle(row.kind);
                  }}
                >
                  {openKind === row.kind ? renderPanel(row.kind) : null}
                </EngineRow>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
