import { useRef, useState, useEffect } from 'react';
import type { MeetingGridHandle } from './MeetingGrid';

const FOCUS_RETRY_MS = 250;

/**
 * After a keyboard delete or rename the row with the focus may be gone: once the work is done and no
 * dialog is open, the focus goes back to the list, on the cursor row.
 */
export function useListFocus({
  dialogOpen,
  cursorId,
  listedIds,
}: {
  readonly dialogOpen: boolean;
  readonly cursorId: string | null;
  readonly listedIds: readonly string[];
}) {
  const gridRef = useRef<MeetingGridHandle>(null);
  const fromKeyboard = useRef(false);
  const wantsListFocus = useRef(false);
  const [workDone, setWorkDone] = useState(0);

  useEffect(() => {
    if (!wantsListFocus.current || dialogOpen) return;
    if (cursorId === null || !listedIds.includes(cursorId)) return;
    const take = (): void => {
      const active = document.activeElement;
      const lost = !active || active === document.body || active.closest('[role="dialog"]');
      if (lost) gridRef.current?.focusCursor();
    };
    take();
    // A dialog that is still fading gives the focus back when it ends, to a row that may be gone.
    const again = setTimeout(take, FOCUS_RETRY_MS);
    wantsListFocus.current = false;
    fromKeyboard.current = false;
    return () => {
      clearTimeout(again);
    };
  }, [cursorId, listedIds, dialogOpen, workDone]);

  return {
    gridRef,
    /** Whether the action under way began from the keyboard, so its end gives the list the focus. */
    setFromKeyboard: (value: boolean): void => {
      fromKeyboard.current = value;
    },
    /** Marks the work done: a keyboard action hands the focus back to the list. */
    afterWork: (): void => {
      if (fromKeyboard.current) wantsListFocus.current = true;
      setWorkDone((count) => count + 1);
    },
  };
}
