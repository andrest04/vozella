import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from './cn';
import { Icon } from './Icon';
import { Input, Textarea } from './Input';

export type InlineSave = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface InlineTextProps {
  readonly value: string;
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  /** Accessible name of the field while it is edited. */
  readonly label: string;
  readonly maxLength: number;
  /** Saves the new text. A failure keeps the field open with its words. */
  readonly onSave: (next: string) => Promise<InlineSave>;
  /** How the text reads when it is not being edited. */
  readonly display: ReactNode;
  readonly multiline?: boolean;
  readonly className?: string;
}

/**
 * Text that is edited in place: it becomes a field where it stands. Enter or leaving the field
 * saves, Escape puts the old text back, and a refusal is said right under the field in words.
 */
export function InlineText({
  value,
  editing,
  onEditingChange,
  label,
  maxLength,
  onSave,
  display,
  multiline = false,
  className,
}: InlineTextProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    setError(null);
    settled.current = false;
    // Focus lands in the field, with the whole text selected, once it is on screen.
    const handle = requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [editing, value]);

  if (!editing) return <>{display}</>;

  const finish = async (): Promise<void> => {
    if (settled.current) return;
    if (draft === value) {
      settled.current = true;
      onEditingChange(false);
      return;
    }
    settled.current = true;
    const result = await onSave(draft);
    if (result.ok) {
      onEditingChange(false);
    } else {
      settled.current = false;
      setError(result.error);
    }
  };
  const cancel = (): void => {
    settled.current = true;
    onEditingChange(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      void finish();
    }
  };
  const common = {
    value: draft,
    maxLength,
    'aria-label': label,
    'aria-invalid': error !== null,
    onChange: (event: { target: { value: string } }): void => {
      setDraft(event.target.value);
      setError(null);
    },
    onKeyDown,
    onBlur: () => {
      void finish();
    },
  };
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {multiline ? (
        <Textarea ref={field} rows={2} {...common} />
      ) : (
        <Input ref={field} {...common} className="w-full" />
      )}
      {error ? (
        <p role="alert" className="flex gap-1.5 text-ui text-ink">
          <Icon icon={CircleAlert} size={14} className="mt-[3px]" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
