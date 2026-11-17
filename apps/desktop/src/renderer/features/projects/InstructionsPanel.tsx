import { CircleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Button, ConfirmDialog, Icon, Textarea } from '../../ui';

export const INSTRUCTIONS_MAX = 20_000;
/** Lines of the instructions the panel shows before "Show all". */
export const EXCERPT_LINES = 6;

export interface InstructionsPanelProps {
  readonly instructions: string;
  /** Saves the text. A string is the reason it was refused, in words. */
  readonly onSave: (text: string) => Promise<string | null>;
  readonly disabled: boolean;
  /**
   * The text being edited, or null when the panel reads. The page holds it, so a draft survives
   * the panel being laid out again (crossing the side-panel breakpoint) and is never lost silently.
   */
  readonly draft: string | null;
  readonly onDraftChange: (draft: string | null) => void;
}

/** The first lines of a text, and whether there is more. */
export function excerptOf(
  text: string,
  lines = EXCERPT_LINES,
): { readonly shown: string; readonly cut: boolean } {
  const all = text.split(/\r?\n/);
  return all.length <= lines
    ? { shown: text, cut: false }
    : { shown: all.slice(0, lines).join('\n'), cut: true };
}

/**
 * What Vozella is told about this project. It reads as an excerpt, and Edit swaps the excerpt for a
 * field in the same place: a live counter, Save and Cancel, Ctrl+Enter to save, Escape to cancel
 * (asking first when the text was changed).
 */
export function InstructionsPanel({
  instructions,
  onSave,
  disabled,
  draft,
  onDraftChange,
}: InstructionsPanelProps) {
  const { t, locale } = useI18n();
  const editing = draft !== null;
  const dirty = draft !== null && draft !== instructions;
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const counterId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) {
      field.current?.focus();
    } else if (wasEditing.current) {
      editButton.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const refusal = await onSave(draft ?? '');
    setBusy(false);
    if (refusal === null) onDraftChange(null);
    else setError(refusal);
  };
  const stopEditing = (): void => {
    setError(null);
    setConfirmDiscard(false);
    onDraftChange(null);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // One keypress must not throw away up to 20,000 characters.
      if (dirty) setConfirmDiscard(true);
      else stopEditing();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  };

  if (draft !== null) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          ref={field}
          rows={8}
          aria-label={t('Ui_ProjectInstructions')}
          aria-describedby={error === null ? counterId : `${counterId} ${errorId}`}
          aria-invalid={error !== null}
          value={draft}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(event) => {
            onDraftChange(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <p id={counterId} className="tabular font-mono text-caption text-ink-muted">
          {t(
            'Ui_ProjectInstructionsCounter',
            draft.length.toLocaleString(locale),
            INSTRUCTIONS_MAX.toLocaleString(locale),
          )}
          {draft.length >= INSTRUCTIONS_MAX ? ` · ${t('Ui_ProjectInstructionsLimit')}` : ''}
        </p>
        {error ? (
          <p id={errorId} role="alert" className="flex gap-1.5 text-ui text-ink">
            <Icon icon={CircleAlert} size={14} className="mt-[3px]" />
            <span>{error}</span>
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('Ui_Save')}
          </Button>
          <Button size="sm" onClick={stopEditing}>
            {t('Ui_Cancel')}
          </Button>
        </div>
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t('Ui_ProjectInstructionsDiscardTitle')}
          description={t('Ui_ProjectInstructionsDiscardContent')}
          cancelLabel={t('Ui_ProjectInstructionsKeepEditing')}
          closeLabel={t('Ui_Close')}
          primaryLabel={t('Ui_ProjectInstructionsDiscard')}
          onConfirm={stopEditing}
        />
      </div>
    );
  }

  const { shown, cut } = excerptOf(instructions);
  return (
    <div className="flex flex-col gap-2">
      {instructions.trim() === '' ? (
        <p className="text-ui text-ink-muted">{t('Ui_ProjectInstructionsEmpty')}</p>
      ) : (
        <>
          <p className="max-w-[65ch] text-ui whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            {expanded ? instructions : shown}
          </p>
          {cut ? (
            <div>
              <Button
                size="sm"
                variant="quiet"
                aria-expanded={expanded}
                onClick={() => {
                  setExpanded(!expanded);
                }}
              >
                {expanded
                  ? t('Ui_ProjectInstructionsShowLess')
                  : t('Ui_ProjectInstructionsShowAll')}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <div>
        <Button
          ref={editButton}
          size="sm"
          disabled={disabled}
          aria-label={t('Ui_ProjectInstructionsEdit')}
          onClick={() => {
            setError(null);
            onDraftChange(instructions);
          }}
        >
          {t('Ui_Edit')}
        </Button>
      </div>
    </div>
  );
}
