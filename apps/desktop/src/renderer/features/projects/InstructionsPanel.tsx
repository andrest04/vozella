import { CircleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button, Icon, Textarea } from '../../ui';

export const INSTRUCTIONS_MAX = 20_000;
/** Lines of the instructions the panel shows before "Show all". */
export const EXCERPT_LINES = 6;

export interface InstructionsPanelProps {
  readonly instructions: string;
  /** Saves the text. A string is the reason it was refused, in words. */
  readonly onSave: (text: string) => Promise<string | null>;
  readonly disabled: boolean;
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
 * field in the same place: a live counter, Save and Cancel, Ctrl+Enter to save, Escape to cancel.
 */
export function InstructionsPanel({ instructions, onSave, disabled }: InstructionsPanelProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(instructions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const counterId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const latest = useRef(instructions);
  latest.current = instructions;

  useEffect(() => {
    if (editing) {
      setDraft(latest.current);
      setError(null);
      field.current?.focus();
    } else if (wasEditing.current) {
      editButton.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const refusal = await onSave(draft);
    setBusy(false);
    if (refusal === null) setEditing(false);
    else setError(refusal);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          ref={field}
          rows={8}
          aria-label={t('Ui_ProjectInstructions')}
          aria-describedby={counterId}
          aria-invalid={error !== null}
          value={draft}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <p id={counterId} className="tabular font-mono text-caption text-ink-muted">
          {t(
            'Ui_ProjectInstructionsCounter',
            draft.length.toLocaleString('en-US'),
            INSTRUCTIONS_MAX.toLocaleString('en-US'),
          )}
          {draft.length >= INSTRUCTIONS_MAX ? ` · ${t('Ui_ProjectInstructionsLimit')}` : ''}
        </p>
        {error ? (
          <p role="alert" className="flex gap-1.5 text-ui text-ink">
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
          <Button
            size="sm"
            onClick={() => {
              setEditing(false);
            }}
          >
            {t('Ui_Cancel')}
          </Button>
        </div>
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
            setEditing(true);
          }}
        >
          {t('Ui_Edit')}
        </Button>
      </div>
    </div>
  );
}
