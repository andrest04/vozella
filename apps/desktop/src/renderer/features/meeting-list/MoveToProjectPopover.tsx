import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Input, Popover, Skeleton, cn } from '../../ui';
import { moveOptions } from './move-options';
import { useConnectedProjectDirectory } from './project-directory';

export interface MoveToProjectPopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The button that opens the popover, or a quiet stand in when the list opens it from a row. */
  readonly trigger: ReactElement;
  /** Where the popup is placed, when it is not under the trigger. */
  readonly anchor?: RefObject<Element | null>;
  /** The project of each meeting being moved (null for none): it decides what is offered. */
  readonly from: readonly (string | null)[];
  readonly onMove: (projectId: string | null) => void;
}

/**
 * Move to project: a searchable flat list in a popover. Typing filters, the arrows move through
 * the list while the focus stays in the field, Enter moves, Escape closes and gives the focus back.
 */
export function MoveToProjectPopover({
  open,
  onOpenChange,
  trigger,
  anchor,
  from,
  onMove,
}: MoveToProjectPopoverProps) {
  const { t, locale } = useI18n();
  const directory = useConnectedProjectDirectory();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const options = useMemo(
    () =>
      moveOptions({
        projects: directory.projects,
        from,
        query,
        locale,
        noProjectLabel: t('Ui_ProjectNone'),
      }),
    [directory.projects, from, query, locale, t],
  );
  const usable = directory.storage.status === 'ready';
  // The list is drawn only when there is something to list; aria-controls must name a real element.
  const listShown = directory.status !== 'loading' && options.length > 0;
  const current = options[Math.min(active, options.length - 1)];
  const optionId = (index: number): string => `${listId}-${String(index)}`;

  useEffect(() => {
    const element = listRef.current?.children[active];
    if (element instanceof HTMLElement && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [active, options]);

  const choose = (projectId: string | null): void => {
    // Move first: the host reads what it is moving from the state closing the popover clears.
    onMove(projectId);
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setActive(Math.max(options.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) choose(current.projectId);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      {...(anchor ? { anchor } : {})}
      label={t('Ui_MoveToProject')}
      align="end"
      className="w-72 p-2"
    >
      {usable ? (
        <div className="flex flex-col gap-2">
          <Input
            type="text"
            role="combobox"
            aria-expanded={listShown}
            {...(listShown ? { 'aria-controls': listId } : {})}
            aria-autocomplete="list"
            {...(current ? { 'aria-activedescendant': optionId(options.indexOf(current)) } : {})}
            aria-label={t('Ui_MoveToProjectSearch')}
            placeholder={t('Ui_MoveToProjectSearch')}
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="w-full"
          />
          {directory.status === 'loading' ? (
            <div role="status" aria-label={t('Ui_Loading')} className="flex flex-col gap-2 py-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : options.length === 0 ? (
            <p role="status" className="px-1 py-2 text-ui text-ink-muted">
              {t('Ui_MoveToProjectEmpty')}
            </p>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={t('Ui_MoveToProject')}
              className="flex max-h-60 flex-col overflow-y-auto"
            >
              {options.map((option, index) => (
                <li
                  key={option.projectId ?? 'none'}
                  id={optionId(index)}
                  role="option"
                  aria-selected={option === current}
                  data-active={option === current ? 'true' : undefined}
                  onClick={() => {
                    choose(option.projectId);
                  }}
                  onMouseMove={() => {
                    setActive(index);
                  }}
                  className={cn(
                    'flex min-h-7 cursor-default items-center rounded-control px-2 py-1 text-ui-lg text-ink select-none',
                    'data-active:bg-hover forced-colors:data-active:bg-[Highlight] forced-colors:data-active:text-[HighlightText]',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p role="status" className="px-1 py-2 text-ui text-ink">
          {t('Ui_ProjectsUnavailableNow')}
        </p>
      )}
    </Popover>
  );
}
