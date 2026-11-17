import type { ProjectListItemDto } from '@vozella/contracts';
import { Link } from '@tanstack/react-router';
import { Pin } from 'lucide-react';
import { IconButton, cn } from '../../ui';

export interface ProjectCardProps {
  readonly project: ProjectListItemDto;
  /** "14 Nov", already formatted. */
  readonly activity: string;
  /** "9 meetings", already worded. */
  readonly meetings: string;
  /** "Pin X", or "Unpin X" when it is pinned: the state is in the name, so it is read once. */
  readonly pinLabel: string;
  readonly pinDisabled: boolean;
  readonly onTogglePin: () => void;
}

/**
 * One project: its name is the link, and the link's hit area is stretched over the whole card, so
 * the card is one target and no button sits inside a link. The pin toggle is a sibling above it.
 */
export function ProjectCard({
  project,
  activity,
  meetings,
  pinLabel,
  pinDisabled,
  onTogglePin,
}: ProjectCardProps) {
  return (
    <article
      className={cn(
        'relative flex min-h-28 flex-col gap-1.5 rounded-overlay border border-hairline bg-paper p-4',
        'transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink',
        'forced-colors:border-[CanvasText]',
      )}
    >
      <h3 className="pe-8 text-ui-lg font-medium text-ink">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className={cn(
            'rounded-control outline-none [overflow-wrap:anywhere]',
            // The pseudo element stretches the link over the card.
            "after:absolute after:inset-0 after:rounded-overlay after:content-['']",
            'focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ink',
          )}
        >
          {project.name}
        </Link>
      </h3>
      {project.description === '' ? null : (
        <p className="line-clamp-2 max-w-[65ch] text-ui text-ink-muted [overflow-wrap:anywhere]">
          {project.description}
        </p>
      )}
      <p className="tabular mt-auto font-mono text-caption text-ink-muted">
        {[activity, meetings].filter((part) => part !== '').join(' · ')}
      </p>
      <IconButton
        label={pinLabel}
        icon={Pin}
        size="sm"
        disabled={pinDisabled}
        onClick={onTogglePin}
        className={cn(
          'absolute end-2 top-2 z-10',
          // A filled pin says "pinned" without colour; the name changes to Unpin as well.
          project.pinned ? 'text-ink [&_svg]:fill-current' : 'text-ink-faint hover:text-ink',
        )}
      />
    </article>
  );
}
