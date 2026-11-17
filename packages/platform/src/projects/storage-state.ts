import type { StorageState, StorageStateSource } from '@vozella/core';

/**
 * The one mutable storage state of a library, shared by every storage adapter. The library
 * runtime sets it as the build progresses; each adapter reads `current()` on every write.
 *
 * Contracts phase: the final shape of the holder. The storage lane owns this file.
 */
export class StorageStateHolder implements StorageStateSource {
  private state: StorageState;

  constructor(initial: StorageState = { status: 'migrating' }) {
    this.state = initial;
  }

  current(): StorageState {
    return this.state;
  }

  set(next: StorageState): void {
    this.state = next;
  }
}
