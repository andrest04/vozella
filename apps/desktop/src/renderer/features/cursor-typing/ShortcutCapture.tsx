import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Input, Kbd } from '../../ui';
import { acceleratorFromKeys, acceleratorKeys } from './cursor-typing-text';

export type ShortcutProblem = 'needs-modifier' | 'unsupported';

export interface ShortcutCaptureProps {
  /** The saved Electron accelerator. */
  readonly accelerator: string;
  readonly disabled: boolean;
  /** "Change shortcut, now Ctrl+Alt+Space". */
  readonly changeLabel: string;
  /** The accessible name while listening; it says that Esc cancels. */
  readonly captureLabel: string;
  readonly prompt: string;
  /** The id of the line that explains a refused combination; it describes the field. */
  readonly problemId: string;
  readonly problem: ShortcutProblem | null;
  readonly onProblem: (problem: ShortcutProblem | null) => void;
  readonly onCapture: (accelerator: string) => void;
}

/**
 * The caps are the button's label, so they take its ink rather than the muted ink of a hint:
 * muted text keeps no contrast margin while the button fades in from disabled.
 */
function Caps({ keys }: { readonly keys: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((cap, index) => (
        <Fragment key={`${cap}-${String(index)}`}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-caption text-ink-muted">
              +
            </span>
          ) : null}
          {/* Important: the shared cap's muted ink comes later in the stylesheet. */}
          <Kbd className="text-ink!">{cap}</Kbd>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The shortcut as key caps on a button; pressing it listens for the next combination. A
 * combination is saved on key down and the field closes on its key up, so the release never lands
 * on the button and starts listening again. Esc cancels, Tab or a click elsewhere leaves it as it
 * was, and a key without Ctrl, Alt or Win is refused while it keeps listening.
 */
export function ShortcutCapture(props: ShortcutCaptureProps) {
  const { onProblem, onCapture } = props;
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (listening || !returnFocus.current) return;
    returnFocus.current = false;
    button.current?.focus();
  }, [listening]);

  const stop = (refocus: boolean): void => {
    returnFocus.current = refocus;
    setPressed(null);
    setListening(false);
    onProblem(null);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const plainTab = event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (plainTab) return; // Focus moves on, and the blur below closes the field.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || pressed !== null) return;
    const result = acceleratorFromKeys(event);
    switch (result.kind) {
      case 'cancel':
        stop(true);
        return;
      case 'waiting':
        return;
      case 'needs-modifier':
      case 'unsupported':
        onProblem(result.kind);
        return;
      case 'accelerator':
        onProblem(null);
        setPressed(result.value);
        onCapture(result.value);
    }
  };

  const keyUp = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (pressed === null) return;
    event.preventDefault();
    stop(true);
  };

  if (listening) {
    return (
      <Input
        autoFocus
        readOnly
        data-testid="InputCursorTypingShortcut"
        aria-label={props.captureLabel}
        aria-describedby={props.problem !== null ? props.problemId : undefined}
        aria-invalid={props.problem !== null}
        placeholder={props.prompt}
        value={pressed === null ? '' : acceleratorKeys(pressed).join('+')}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onBlur={() => {
          stop(false);
        }}
        className="w-48 caret-transparent"
      />
    );
  }

  return (
    <Button
      ref={button}
      data-testid="BtnCursorTypingShortcut"
      aria-label={props.changeLabel}
      disabled={props.disabled}
      onClick={() => {
        setListening(true);
      }}
      className="px-2"
    >
      <Caps keys={acceleratorKeys(props.accelerator)} />
    </Button>
  );
}
