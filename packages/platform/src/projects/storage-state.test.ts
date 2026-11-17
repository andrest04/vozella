import { describe, expect, it } from 'vitest';
import { StorageStateHolder } from './storage-state';

describe('StorageStateHolder', () => {
  it('starts migrating, and every reader sees the latest state', () => {
    const holder = new StorageStateHolder();
    const reader = holder as { current(): unknown };
    expect(reader.current()).toEqual({ status: 'migrating' });
    holder.set({ status: 'ready' });
    expect(reader.current()).toEqual({ status: 'ready' });
    holder.set({ status: 'newer', found: 3, supported: 1 });
    expect(reader.current()).toEqual({ status: 'newer', found: 3, supported: 1 });
  });

  it('can start in any state', () => {
    expect(new StorageStateHolder({ status: 'error', message: 'x' }).current()).toEqual({
      status: 'error',
      message: 'x',
    });
  });
});
