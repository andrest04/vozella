import { useEffect, useState } from 'react';
import type { UpdateState } from '@vozella/contracts';

/** Main's update state: read once, then followed. A push that lands first wins over the read. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.vozella.on('updates.stateChanged', (next) => {
      setState(next);
    });
    window.vozella
      .invoke('updates.getState', {})
      .then((next) => {
        if (alive) setState((current) => current ?? next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
