import { CalendarPlus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Checkbox, Field, Icon, Input, cn } from '../../ui';
import { awaitsNextSession, exportableIndexes, type ActionItemDto } from './summary-tab-model';

export interface ActionItemsLabels {
  /** The visible "Action items" heading. */
  readonly heading: string;
  readonly addDate: string;
  /** Accessible name of the date button, given the formatted date. */
  readonly changeDate: (date: string) => string;
  /** Accessible name of the date field, given the item text. */
  readonly dateFor: (text: string) => string;
  readonly clearDate: string;
  readonly nextSessionQuestion: string;
  readonly nextSessionHint: string;
  readonly nextSessionSave: string;
  readonly nextSessionInvalid: string;
  readonly exportIcs: string;
  readonly exportNone: string;
}

export interface ActionItemsListProps {
  readonly items: readonly ActionItemDto[];
  readonly labels: ActionItemsLabels;
  readonly onToggle: (index: number, done: boolean) => void;
  /** A confirmed `YYYY-MM-DD`, or null to clear it. */
  readonly onSetDate: (index: number, date: string | null) => void;
  readonly onSaveNextSession: (date: string) => Promise<'saved' | 'invalid-date' | 'failed'>;
  readonly onExport: (indexes: readonly number[]) => void;
  readonly exporting: boolean;
  /** `YYYY-MM-DD` as the reader's short local day. */
  readonly formatDate: (isoDay: string) => string;
}

/**
 * One checkbox per item under a heading. Under the text a quiet line says who, when and the words
 * that set the date, so a date is never shown without its reason and never made up.
 */
export function ActionItemsList(props: ActionItemsListProps) {
  const { items, labels } = props;
  const hintId = useId();
  if (items.length === 0) return null;
  const exportable = exportableIndexes(items);
  const canExport = exportable.length > 0;
  return (
    <section aria-labelledby="summary-action-items" className="mt-9 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="summary-action-items" className="text-read font-semibold">
          {labels.heading}
        </h2>
        <div className="flex min-w-0 items-center gap-3">
          {canExport ? null : (
            <span id={hintId} className="text-ui text-ink-muted">
              {labels.exportNone}
            </span>
          )}
          <Button
            size="sm"
            icon={CalendarPlus}
            data-testid="BtnExportIcs"
            disabled={!canExport || props.exporting}
            aria-describedby={canExport ? undefined : hintId}
            onClick={() => {
              props.onExport(exportable);
            }}
          >
            {labels.exportIcs}
          </Button>
        </div>
      </div>
      {awaitsNextSession(items) ? (
        <NextSessionPrompt labels={labels} onSave={props.onSaveNextSession} />
      ) : null}
      <ul data-testid="ListActionItems" className="mt-3 flex flex-col gap-3">
        {items.map((item, index) => (
          <li key={index}>
            <Checkbox
              checked={item.isDone}
              onCheckedChange={(checked) => {
                props.onToggle(index, checked);
              }}
              label={
                <span className={cn('text-read', item.isDone && 'text-ink-muted line-through')}>
                  {item.text}
                </span>
              }
            />
            <ItemDetails
              item={item}
              labels={labels}
              formatDate={props.formatDate}
              onSetDate={(date) => {
                props.onSetDate(index, date);
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

const Separator = () => <span aria-hidden="true"> · </span>;

/** Owner, date and quote, indented under the text past the checkbox (16px box + 10px gap). */
function ItemDetails({
  item,
  labels,
  formatDate,
  onSetDate,
}: {
  readonly item: ActionItemDto;
  readonly labels: ActionItemsLabels;
  readonly formatDate: (isoDay: string) => string;
  readonly onSetDate: (date: string | null) => void;
}) {
  const owner = item.owner?.trim() ?? '';
  const deadline = item.deadline;
  if (owner === '' && deadline === undefined) return null;
  const quote = deadline?.quote.trim() ?? '';
  return (
    <p
      data-testid="ActionItemMeta"
      className="mt-0.5 ps-[26px] text-ui leading-6 text-ink-muted [overflow-wrap:anywhere]"
    >
      {owner !== '' ? <span>{owner}</span> : null}
      {owner !== '' && deadline ? <Separator /> : null}
      {deadline ? (
        <DateControl
          date={deadline.date}
          itemText={item.text}
          labels={labels}
          formatDate={formatDate}
          onSetDate={onSetDate}
        />
      ) : null}
      {quote !== '' ? (
        <>
          <Separator />
          <span className="italic">“{quote}”</span>
        </>
      ) : null}
    </p>
  );
}

const inlineAction =
  'inline-flex h-6 items-center gap-1 rounded-control px-1 align-middle text-ui ' +
  'transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed';

/**
 * The date as a quiet button; pressing it swaps in a native date field of the same height.
 * Enter or leaving the field saves, Escape keeps the old date. Focus comes back to the button.
 */
function DateControl({
  date,
  itemText,
  labels,
  formatDate,
  onSetDate,
}: {
  readonly date: string | undefined;
  readonly itemText: string;
  readonly labels: ActionItemsLabels;
  readonly formatDate: (isoDay: string) => string;
  readonly onSetDate: (date: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const closed = useRef(false);
  const restoreFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = date === undefined ? '' : formatDate(date);

  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    trigger.current?.focus();
  }, [editing, date]);

  const open = (): void => {
    closed.current = false;
    setDraft(date ?? '');
    setEditing(true);
  };
  const close = (save: boolean): void => {
    if (closed.current) return;
    closed.current = true;
    restoreFocus.current = true;
    setEditing(false);
    if (save && draft !== '' && draft !== date) onSetDate(draft);
  };

  if (editing) {
    return (
      <Input
        type="date"
        autoFocus
        data-testid="DateActionItem"
        aria-label={labels.dateFor(itemText)}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            close(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(false);
          }
        }}
        onBlur={() => {
          close(true);
        }}
        className="h-6! w-auto px-1.5 align-middle text-ui!"
      />
    );
  }
  if (date === undefined || shown === '') {
    return (
      <button
        ref={trigger}
        type="button"
        data-testid="BtnActionItemDate"
        onClick={open}
        className={cn(inlineAction, 'text-ink underline decoration-dotted underline-offset-4')}
      >
        {labels.addDate}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center align-middle">
      <button
        ref={trigger}
        type="button"
        data-testid="BtnActionItemDate"
        aria-label={labels.changeDate(shown)}
        onClick={open}
        className={cn(inlineAction, 'font-medium text-ink')}
      >
        {shown}
      </button>
      <button
        type="button"
        data-testid="BtnClearActionItemDate"
        aria-label={labels.clearDate}
        title={labels.clearDate}
        onClick={() => {
          restoreFocus.current = true;
          onSetDate(null);
        }}
        className={cn(inlineAction, 'w-6 justify-center text-ink-muted hover:text-ink')}
      >
        <Icon icon={X} size={12} />
      </button>
    </span>
  );
}

/** One compact question above the list while some item waits for "the next session". */
function NextSessionPrompt({
  labels,
  onSave,
}: {
  readonly labels: ActionItemsLabels;
  readonly onSave: (date: string) => Promise<'saved' | 'invalid-date' | 'failed'>;
}) {
  const [date, setDate] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = (): void => {
    if (date === '' || saving) return;
    setSaving(true);
    void onSave(date).then((result) => {
      setSaving(false);
      setInvalid(result === 'invalid-date');
    });
  };
  return (
    <div
      data-testid="NextSessionPrompt"
      className="mt-4 rounded-control border border-hairline bg-paper-raised px-3 py-2.5"
    >
      <Field
        label={labels.nextSessionQuestion}
        description={labels.nextSessionHint}
        error={invalid ? labels.nextSessionInvalid : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            data-testid="DateNextSession"
            value={date}
            onChange={(event) => {
              setDate(event.currentTarget.value);
              setInvalid(false);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            }}
            className="w-auto"
          />
          <Button
            size="md"
            data-testid="BtnSaveNextSession"
            disabled={date === '' || saving}
            onClick={save}
          >
            {labels.nextSessionSave}
          </Button>
        </div>
      </Field>
    </div>
  );
}
