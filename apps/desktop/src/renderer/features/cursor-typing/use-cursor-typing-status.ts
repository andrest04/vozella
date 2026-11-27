import { cursorTypingStatusSchema, type CursorTypingStatusDto } from '@vozella/contracts';
import { useEffect, useState } from 'react';

/**
 * The type at cursor status main owns: the typer state, the shortcut and the last refusal. It
 * listens first and then asks once, so a push that lands before the answer is never overwritten
 * by the older answer. Null until main has said anything usable.
 */
export function useCursorTypingStatus(): CursorTypingStatusDto | null {
  const [status, setStatus] = useState<CursorTypingStatusDto | null>(null);

  useEffect(() => {
    let alive = true;
    const off = window.vozella.on('cursorTyping.state', (next) => {
      if (alive) setStatus(next);
    });
    window.vozella
      .invoke('cursorTyping.getState', {})
      .then((answer) => {
        const parsed = cursorTypingStatusSchema.safeParse(answer);
        if (alive && parsed.success) setStatus((current) => current ?? parsed.data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return status;
}
