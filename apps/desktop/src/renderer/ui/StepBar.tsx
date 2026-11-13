import { Radio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { cn } from './cn';

export interface StepBarStep {
  readonly value: string;
  /** The readable name, read by screen readers and shown beside the bar when chosen. */
  readonly label: string;
}

export interface StepBarProps {
  /** Accessible name of the group; also the visible label before the bar. */
  readonly label: string;
  readonly steps: readonly StepBarStep[];
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  readonly className?: string;
  /** Automation id on the group. */
  readonly testId?: string;
}

/**
 * A stepped bar for an ordered setting (low to max): one segment per step, filled in ink up to the
 * chosen one, with its name beside the bar. It is a radio group: arrows move, Tab leaves.
 */
export function StepBar({ label, steps, value, onValueChange, className, testId }: StepBarProps) {
  const chosen = steps.findIndex((step) => step.value === value);
  const current = steps[chosen];
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span aria-hidden="true" className="shrink-0 text-ui text-ink-muted">
        {label}
      </span>
      <BaseRadioGroup
        aria-label={label}
        data-testid={testId}
        value={value ?? ''}
        onValueChange={(next) => {
          if (typeof next === 'string') onValueChange(next);
        }}
        className="flex min-w-0 flex-1 items-center gap-1"
      >
        {steps.map((step, index) => (
          // The 24 px button is the target; the 6 px segment inside is what you see.
          <Radio.Root
            key={step.value}
            value={step.value}
            aria-label={step.label}
            className="group/step flex h-6 min-w-6 flex-1 cursor-default items-center rounded-control outline-offset-1"
          >
            <span
              aria-hidden="true"
              className={cn(
                'block h-1.5 w-full rounded-control transition-colors duration-150 ease-out-quick motion-reduce:transition-none',
                index <= chosen
                  ? 'bg-ink forced-colors:bg-[Highlight]'
                  : 'bg-hairline group-hover/step:bg-border-control forced-colors:bg-[GrayText]',
              )}
            />
          </Radio.Root>
        ))}
      </BaseRadioGroup>
      <span aria-hidden="true" className="w-16 shrink-0 truncate text-end text-ui text-ink">
        {current?.label ?? ''}
      </span>
    </div>
  );
}
