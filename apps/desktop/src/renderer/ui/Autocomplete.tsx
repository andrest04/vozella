import { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete';
import { Check, ChevronDown } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';
import { controlSurface, popupColors, popupItem, popupSurface } from './styles';

export interface AutocompleteOption {
  /** What the field holds and commits. */
  readonly value: string;
  /** What people read. When it differs from the value, the value shows beneath it. */
  readonly label: string;
}

export interface AutocompleteProps {
  readonly options: readonly AutocompleteOption[];
  /** The text in the field. */
  readonly value: string;
  /** Every change of the text: typing, or a picked option. */
  readonly onValueChange: (value: string) => void;
  /** The text is final: an option was picked, Enter was pressed, or focus left the field. */
  readonly onCommit: (value: string) => void;
  /** Accessible name of the field, when no visible label names it through `aria-labelledby`. */
  readonly label?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  /** Accessible name of the chevron that opens the list. */
  readonly openLabel: string;
  readonly placeholder?: string;
  readonly className?: string;
  /** Automation id on the option list. */
  readonly listTestId?: string;
}

/** Why the text changed, as Base UI reports it. Only these mean the user is typing a query. */
const TYPING = new Set(['input-change', 'input-paste', 'input-clear']);

const matches = (option: AutocompleteOption, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return (
    needle === '' ||
    option.value.toLowerCase().includes(needle) ||
    option.label.toLowerCase().includes(needle)
  );
};

/**
 * A text field with suggestions: any text is allowed, and the list helps pick a known one.
 * Opening it (click, ArrowDown, the chevron) shows every option whatever the field holds; only
 * typing filters. Arrows move, Enter or a click picks, Escape closes, leaving the field commits.
 */
export function Autocomplete({
  options,
  value,
  onValueChange,
  onCommit,
  label,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  openLabel,
  placeholder,
  className,
  listTestId,
}: AutocompleteProps) {
  // Null until the user types after opening, so an opened list starts complete.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const highlighted = useRef<AutocompleteOption | undefined>(undefined);
  const visible = query === null ? options : options.filter((option) => matches(option, query));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // With an option highlighted, Enter picks it (committed through onValueChange below).
    if (event.key === 'Enter' && highlighted.current === undefined) {
      onCommit(event.currentTarget.value);
    }
  };

  return (
    <BaseAutocomplete.Root
      items={options}
      filteredItems={visible}
      itemToStringValue={(item: AutocompleteOption) => item.value}
      value={value}
      // With nothing to suggest the list stays shut, so the page is never hidden behind it.
      open={open && visible.length > 0}
      openOnInputClick
      onValueChange={(next, details) => {
        // Escape on a closed list would empty the field; the text stays, as in any input.
        if (details.reason === 'escape-key') return;
        if (TYPING.has(details.reason)) setQuery(next);
        onValueChange(next);
        if (details.reason === 'item-press') onCommit(next);
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery(null);
      }}
      onItemHighlighted={(item) => {
        highlighted.current = item;
      }}
    >
      <BaseAutocomplete.InputGroup
        className={cn(
          controlSurface,
          'relative flex h-8 min-w-56 items-center',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink',
          className,
        )}
      >
        <BaseAutocomplete.Input
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            // A list held shut for want of options must not pop open later on its own.
            setOpen(false);
            setQuery(null);
            onCommit(event.currentTarget.value);
          }}
          className="h-full min-w-0 flex-1 bg-transparent pr-1 pl-2.5 text-ui-lg outline-none placeholder:text-ink-faint"
        />
        <BaseAutocomplete.Trigger
          aria-label={openLabel}
          className="me-0.5 flex size-7 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-hover active:bg-pressed"
        >
          <Icon icon={ChevronDown} size={14} />
        </BaseAutocomplete.Trigger>
      </BaseAutocomplete.InputGroup>
      <BaseAutocomplete.Portal>
        <BaseAutocomplete.Positioner sideOffset={4} className="z-50 outline-none">
          <BaseAutocomplete.Popup
            className={cn(popupSurface, popupColors, 'w-[var(--anchor-width)] min-w-56 p-1')}
          >
            <BaseAutocomplete.List
              data-testid={listTestId}
              className="max-h-[min(16rem,var(--available-height))] overflow-y-auto outline-none"
            >
              {(item: AutocompleteOption) => {
                const current = item.value === value;
                return (
                  <BaseAutocomplete.Item
                    key={item.value}
                    value={item}
                    className={cn(
                      popupItem,
                      'grid grid-cols-[14px_1fr] gap-2',
                      current && 'bg-pressed data-highlighted:bg-pressed',
                    )}
                  >
                    <span className="col-start-1 flex">
                      {current ? <Icon icon={Check} size={14} /> : null}
                    </span>
                    <span className="col-start-2 flex min-w-0 flex-col py-0.5">
                      <span className="truncate">{item.label}</span>
                      {item.label === item.value ? null : (
                        <span className="truncate text-ui text-ink-muted">{item.value}</span>
                      )}
                    </span>
                  </BaseAutocomplete.Item>
                );
              }}
            </BaseAutocomplete.List>
          </BaseAutocomplete.Popup>
        </BaseAutocomplete.Positioner>
      </BaseAutocomplete.Portal>
    </BaseAutocomplete.Root>
  );
}
