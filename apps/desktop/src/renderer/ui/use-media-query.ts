import { useEffect, useState } from 'react';

const supported = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** Whether a media query matches now, and again whenever it changes. False where there is none. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    supported() ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (!supported()) return;
    const list = window.matchMedia(query);
    const update = (): void => {
      setMatches(list.matches);
    };
    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, [query]);
  return matches;
}
