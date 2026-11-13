import { useEffect, type RefObject } from 'react';

type Source = () => Promise<string | null>;

/**
 * Registers a tab's text for the session page's Copy button. Pass a stable `source` (useCallback).
 *
 * On unmount the tab clears the ref only while it still owns it. The tabs panel keeps the leaving
 * tab mounted until its exit transition ends, so the entering tab registers first; an unconditional
 * clear would wipe the entering tab's source and leave Copy doing nothing.
 */
export function useCopySource(ref: RefObject<Source | null> | undefined, source: Source | null) {
  useEffect(() => {
    if (!ref || source === null) return;
    ref.current = source;
    return () => {
      if (ref.current === source) ref.current = null;
    };
  }, [ref, source]);
}
