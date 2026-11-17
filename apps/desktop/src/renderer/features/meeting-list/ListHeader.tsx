import { Search, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Button, Icon, IconButton, Input } from '../../ui';

export interface ListHeaderProps {
  /** The name of the list. Null where the page above already names it (a project's meetings). */
  readonly title: string | null;
  /** Beside the search: the control that picks the scope, where the list has one. */
  readonly scopeControl?: ReactNode;
  readonly count: number;
  /** What the count reads: the number alone, or the filtered number of it. */
  readonly countText: string;
  /** The filter button, beside the search, and its chips, under it. */
  readonly filterButton: ReactNode;
  readonly filterChips: ReactNode;
  /** Said to a screen reader when the filters change the list; empty with none on. */
  readonly filterResults: string;
  readonly filterResultsLabel: string;
  readonly query: string;
  readonly searchLabel: string;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly clearSearchLabel: string;
  readonly onQueryChange: (value: string) => void;
  /** One quiet line about the search under way; empty when there is nothing to say. */
  readonly searchStatus: string;
  /** The way to widen the search to everything. Absent where it already covers everything. */
  readonly searchAll: { readonly label: string; readonly onSelect: () => void } | null;
}

/** The head of the list pane: its name when it has one, the search, the filters and their chips. */
export function ListHeader({
  title,
  scopeControl,
  count,
  countText,
  filterButton,
  filterChips,
  filterResults,
  filterResultsLabel,
  query,
  searchLabel,
  searchRef,
  onSearchKeyDown,
  clearSearchLabel,
  onQueryChange,
  searchStatus,
  searchAll,
}: ListHeaderProps) {
  return (
    <header className="flex shrink-0 flex-col gap-1.5 px-4 pb-3">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        {title === null ? null : (
          <h1 className="truncate text-heading font-semibold tracking-[-0.01em]">{title}</h1>
        )}
        {/* While loading it is not yet known, and with nothing listed the list says so itself. */}
        {count === 0 ? null : (
          <span
            data-testid="library-view-count"
            className="tabular shrink-0 pt-1 font-mono text-caption text-ink-faint"
          >
            {countText}
          </span>
        )}
        {/* Mounted before it has anything to say, or the first change would not be announced. */}
        <span role="status" aria-label={filterResultsLabel} className="sr-only">
          {filterResults}
        </span>
        {scopeControl === undefined ? null : (
          <span className="ms-auto shrink-0">{scopeControl}</span>
        )}
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon
            icon={Search}
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
          />
          <Input
            ref={searchRef}
            type="search"
            onKeyDown={onSearchKeyDown}
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            className="w-full pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query === '' ? null : (
            <IconButton
              label={clearSearchLabel}
              icon={X}
              size="sm"
              className="absolute top-1/2 right-0.5 -translate-y-1/2"
              onClick={() => {
                onQueryChange('');
                searchRef.current?.focus();
              }}
            />
          )}
        </div>
        {filterButton}
      </div>
      {filterChips}
      {query === '' ? null : (
        <div className="flex min-h-7 items-center justify-between gap-2">
          <span role="status" className="min-w-0 truncate text-ui text-ink-muted">
            {searchStatus}
          </span>
          {searchAll ? (
            <Button size="sm" variant="quiet" className="shrink-0" onClick={searchAll.onSelect}>
              {searchAll.label}
            </Button>
          ) : null}
        </div>
      )}
    </header>
  );
}
