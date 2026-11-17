import {
  InMemoryChatThreadRepository,
  type ChatThreadRepository,
  type Clock,
  type Logger,
  type StorageLayout,
  type StorageStateSource,
} from '@vozella/core';

export interface ChatThreadStoreDeps {
  readonly layout: StorageLayout;
  readonly state: StorageStateSource;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Electron's `shell.trashItem`; without it a deleted thread file is removed outright. */
  readonly discard?: (path: string) => Promise<void>;
}

/**
 * Saved conversations: `chats/<threadId>.json` under the owner's directory.
 *
 * Contracts phase stub with the final signature: it answers with the in-memory fake. The chat
 * lane replaces the body.
 */
export function createChatThreadStore(deps: ChatThreadStoreDeps): ChatThreadRepository {
  return new InMemoryChatThreadRepository(deps.state);
}
