import type { ChatEngineChoicesDto, ChatEngineDto } from '@vozella/contracts';
import { Check, ChevronDown } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button, Icon, Input, Popover, StepBar, cn } from '../../ui';
import { ProviderMark } from '../ai-provider/ProviderMark';
import { ENGINE_STATUS_KEYS, engineStatus } from '../settings/engine-status';
import { ENGINE_LABEL } from './chat-prompts-view';
import {
  GROUP_CAPTION,
  SETTINGS_KIND,
  effortKey,
  pickerGroups,
  readableModel,
  setupActionKey,
  type ModelChoice,
  type PickerGroup,
} from './model-choice';
import type { ModelChoiceStatus } from './use-model-choice';

export interface ChatModelPickerProps {
  readonly status: ModelChoiceStatus;
  readonly choices: ChatEngineChoicesDto | null;
  readonly choice: ModelChoice | null;
  /** The popup opened: read the choices again. */
  readonly onOpen: () => void;
  readonly onPick: (engine: ChatEngineDto, modelId: string) => void;
  readonly onEffort: (effort: string) => void;
  /** Opens this engine in Settings (an engine that is not ready, or more local models). */
  readonly onSetup: (engine: ChatEngineDto) => void;
  /**
   * The composer box the chip sits in. The popup opens above it, right edges aligned, so it never
   * covers the message field. Default: the chip itself.
   */
  readonly anchor?: RefObject<Element | null>;
}

/** One row of the list, in keyboard order. */
type Row =
  | { readonly kind: 'model'; readonly engine: ChatEngineDto; readonly modelId: string }
  | { readonly kind: 'setup' | 'more'; readonly engine: ChatEngineDto };

const optionIdOf = (baseId: string, index: number): string => `${baseId}-option-${String(index)}`;

/** The rows of the groups, flat, in the order they are drawn. */
function rowsOf(groups: readonly PickerGroup[], showMore: boolean): readonly Row[] {
  const rows: Row[] = [];
  for (const group of groups) {
    for (const item of group.engines) {
      if (!item.pickable) {
        rows.push({ kind: 'setup', engine: item.engine });
        continue;
      }
      for (const model of item.models) {
        rows.push({ kind: 'model', engine: item.engine, modelId: model.id });
      }
      if (item.engine === 'local' && showMore) rows.push({ kind: 'more', engine: 'local' });
    }
  }
  return rows;
}

const isRow = (a: Row, b: Row): boolean =>
  a.kind === b.kind &&
  a.engine === b.engine &&
  (a.kind !== 'model' || (b.kind === 'model' && a.modelId === b.modelId));

/**
 * The model chip beside Send and its popup: search, the engines in their groups (ready ones list
 * their models, the others one dimmed row that opens them in Settings), the effort bar for an
 * engine that has one, and a note that the choice is for this chat only. Focus stays in the
 * search field; the list follows it with aria-activedescendant.
 */
export function ChatModelPicker({
  status,
  choices,
  choice,
  onOpen,
  onPick,
  onEffort,
  onSetup,
  anchor,
}: ChatModelPickerProps) {
  const t = useT();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  const engineName = (engine: ChatEngineDto): string => t(ENGINE_LABEL[engine]);
  const groups = useMemo(
    () => (choices ? pickerGroups(choices, query, (engine) => t(ENGINE_LABEL[engine])) : []),
    [choices, query, t],
  );
  const rows = useMemo(() => rowsOf(groups, query.trim() === ''), [groups, query]);
  const optionId = (index: number): string => optionIdOf(baseId, index);

  const selectedIndex = (): number =>
    choice
      ? rows.findIndex(
          (row) =>
            row.kind === 'model' && row.engine === choice.engine && row.modelId === choice.model,
        )
      : -1;

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionIdOf(baseId, active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open, baseId]);

  if (status === 'failed') return null;

  const entryOf = (engine: ChatEngineDto) =>
    choices?.engines.find((entry) => entry.engine === engine);
  const chosenEntry = choice ? entryOf(choice.engine) : undefined;
  const modelLabel = (engine: ChatEngineDto, modelId: string): string => {
    const model = entryOf(engine)?.models.find((item) => item.id === modelId);
    return readableModel(engine, model ?? { id: modelId, label: modelId });
  };
  const effortLabel = (effort: string): string => {
    const key = effortKey(effort);
    return key ? t(key) : effort;
  };

  const visible = choice
    ? [
        choice.model === null ? engineName(choice.engine) : modelLabel(choice.engine, choice.model),
        chosenEntry && chosenEntry.effortOptions.length > 0 && choice.effort !== null
          ? effortLabel(choice.effort)
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : t('Ui_ChatModelChip');
  const chipName = choice
    ? t('Ui_ChatModelChipName', engineName(choice.engine), visible)
    : t('Ui_ChatModelChip');

  const close = (): void => {
    setOpen(false);
  };

  const activate = (row: Row): void => {
    if (row.kind === 'model') {
      onPick(row.engine, row.modelId);
      return;
    }
    close();
    onSetup(row.engine);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const last = rows.length - 1;
    const move = (next: number): void => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(last, next)));
    };
    switch (event.key) {
      case 'ArrowDown':
        move(active + 1);
        break;
      case 'ArrowUp':
        move(active - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(last);
        break;
      case 'Enter': {
        const row = rows[active];
        if (!row) return;
        event.preventDefault();
        activate(row);
        break;
      }
      default:
        break;
    }
  };

  const option = (row: Row) => {
    const at = rows.findIndex((item) => isRow(item, row));
    const id = optionId(at);
    const isActive = at === active;
    const common = {
      id,
      role: 'option',
      // Keep the caret in the search field: a click must not move focus.
      onMouseDown: (event: { preventDefault: () => void }) => {
        event.preventDefault();
      },
      onMouseMove: () => {
        if (at !== active) setActive(at);
      },
      onClick: () => {
        activate(row);
      },
    } as const;

    if (row.kind === 'model') {
      const selected = choice?.engine === row.engine && choice.model === row.modelId;
      return (
        <li
          key={`${row.engine}:${row.modelId}`}
          {...common}
          aria-selected={selected}
          aria-describedby={`${baseId}-${row.engine}-name`}
          data-testid="ItemChatModel"
          className={cn(
            'flex min-h-7 cursor-default items-center gap-2 rounded-control ps-8 pe-2 py-1 text-ui-lg text-ink select-none',
            isActive && 'bg-hover',
            'forced-colors:aria-selected:bg-[Highlight] forced-colors:aria-selected:text-[HighlightText]',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{modelLabel(row.engine, row.modelId)}</span>
          {selected ? <Icon icon={Check} size={14} className="shrink-0" /> : null}
        </li>
      );
    }

    if (row.kind === 'more') {
      return (
        <li
          key="local:more"
          {...common}
          aria-selected={false}
          data-testid="ItemChatModelMore"
          className={cn(
            'flex min-h-7 cursor-default items-center rounded-control ps-8 pe-2 py-1 text-ui text-ink-muted select-none',
            isActive && 'bg-hover',
          )}
        >
          {t('Ui_ChatModelMoreLocal')}
        </li>
      );
    }

    const entry = entryOf(row.engine);
    const state = entry
      ? engineStatus(SETTINGS_KIND[row.engine], entry.readiness, { inUse: false, keySet: false })
      : null;
    const nameId = `${id}-name`;
    const reasonId = `${id}-reason`;
    const actionId = `${id}-action`;
    return (
      <li
        key={`${row.engine}:setup`}
        {...common}
        aria-selected={false}
        // Named by everything it shows (engine, reason, action), so a voice user's words match.
        aria-labelledby={state ? `${nameId} ${reasonId} ${actionId}` : `${nameId} ${actionId}`}
        data-testid="ItemChatModelSetup"
        className={cn(
          'flex min-h-8 cursor-default items-center gap-2 rounded-control px-2 py-1 select-none',
          isActive && 'bg-hover',
        )}
      >
        <span className="text-ink-muted">
          <ProviderMark kind={SETTINGS_KIND[row.engine]} />
        </span>
        <span id={nameId} className="shrink-0 text-ui-lg text-ink-muted">
          {engineName(row.engine)}
        </span>
        {/* Spaces between the parts keep the row's text readable as words; flex hides them. */}{' '}
        {state ? (
          <span id={reasonId} className="min-w-0 flex-1 truncate text-ui text-ink-muted">
            {t(ENGINE_STATUS_KEYS[state])}
          </span>
        ) : (
          <span className="flex-1" />
        )}{' '}
        {/* The whole row is the action; this only names it, so it is not a second button. */}
        <span
          id={actionId}
          className="flex h-6 shrink-0 items-center rounded-control border border-border-control bg-paper px-2 text-ui text-ink"
        >
          {entry ? t(setupActionKey(entry)) : t('Ui_ChatModelSetUp')}
        </span>
      </li>
    );
  };

  const effortSteps =
    chosenEntry && chosenEntry.effortOptions.length > 0
      ? chosenEntry.effortOptions.map((value) => ({ value, label: effortLabel(value) }))
      : null;

  const trigger = (
    <Button
      variant="quiet"
      size="sm"
      data-testid="BtnChatModel"
      aria-label={chipName}
      disabled={status === 'loading'}
      className="min-w-0 shrink gap-1 px-1.5 font-normal text-ink-muted hover:not-data-disabled:text-ink data-popup-open:bg-hover data-popup-open:text-ink"
    >
      {choice ? <ProviderMark kind={SETTINGS_KIND[choice.engine]} size={14} /> : null}
      <span className="min-w-0 truncate">{visible}</span>
      <Icon icon={ChevronDown} size={12} className="shrink-0 text-ink-faint" />
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(Math.max(0, selectedIndex()));
          onOpen();
        }
      }}
      trigger={trigger}
      tooltip={chipName}
      label={t('Ui_ChatModelList')}
      side="top"
      align="end"
      {...(anchor ? { anchor } : {})}
      sideOffset={8}
      initialFocus={search}
      // The positioner's available height keeps a short panel's popup inside the window.
      className="flex max-h-[min(30rem,var(--available-height))] w-[min(22.5rem,calc(100vw-1rem))] flex-col"
    >
      <div className="p-1.5 pb-1">
        <Input
          ref={search}
          role="combobox"
          aria-label={t('Ui_ChatModelSearch')}
          aria-expanded={true}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? optionId(active) : undefined}
          placeholder={t('Ui_ChatModelSearch')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          data-testid="TxtChatModelSearch"
          className="w-full"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={t('Ui_ChatModelList')}
        // The search field drives the list; a scrolling list must not take a Tab stop of its own.
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-1 outline-none"
      >
        {groups.map((group) => (
          <li
            key={group.id}
            role="group"
            aria-labelledby={`${baseId}-${group.id}`}
            className="pt-1"
          >
            <div
              id={`${baseId}-${group.id}`}
              role="presentation"
              className="px-2 pt-1 pb-0.5 text-caption font-medium text-ink-muted forced-colors:text-inherit"
            >
              {t(GROUP_CAPTION[group.id])}
            </div>
            <ul role="none">
              {group.engines.map((item) =>
                item.pickable ? (
                  <li key={item.engine} role="none">
                    <div
                      id={`${baseId}-${item.engine}-name`}
                      role="presentation"
                      className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-ui text-ink-muted"
                    >
                      <ProviderMark kind={SETTINGS_KIND[item.engine]} size={14} />
                      {engineName(item.engine)}
                    </div>
                    <ul role="none">
                      {rows
                        .filter((row) => row.engine === item.engine && row.kind !== 'setup')
                        .map((row) => option(row))}
                    </ul>
                  </li>
                ) : (
                  option({ kind: 'setup', engine: item.engine })
                ),
              )}
            </ul>
          </li>
        ))}
      </ul>
      {rows.length === 0 ? (
        <p role="status" className="px-3 pb-3 text-ui text-ink-muted">
          {t('Ui_ChatModelNoMatch')}
        </p>
      ) : null}
      {effortSteps && choice ? (
        <StepBar
          label={t('Ui_ChatModelEffort')}
          steps={effortSteps}
          value={choice.effort}
          onValueChange={onEffort}
          testId="RadChatModelEffort"
          className="border-t border-hairline px-3 py-2"
        />
      ) : null}
      <p className="border-t border-hairline px-3 py-2 text-caption text-ink-muted">
        {t('Ui_ChatModelFooter')}
      </p>
    </Popover>
  );
}
