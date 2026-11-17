import type { Result } from '../projects/ports';
import type { ChatScopeKind } from './scope-resolver';

/** The project that owns a thread; null is "no project". */
export type ThreadOwner = string | null;

/**
 * What a thread is about, as the page sees and pins it. `projectId` is always the owner;
 * `meetingId` is set for the Meeting scope only.
 */
export interface ThreadScope {
  readonly kind: ChatScopeKind;
  readonly projectId: string | null;
  readonly meetingId: string | null;
}

/** One saved turn. Text only: attachments are not persisted. */
export interface ThreadMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
}

/** A conversation as stored. The owner is fixed when the thread is created. */
export interface ChatThread {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ownerProjectId: ThreadOwner;
  readonly scope: { readonly kind: ChatScopeKind; readonly meetingId: string | null };
  /** The first user message on one line, cut at 60 characters; renamable. */
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ThreadMessage[];
}

export interface ChatThreadSummary {
  readonly id: string;
  readonly ownerProjectId: ThreadOwner;
  readonly scope: { readonly kind: ChatScopeKind; readonly meetingId: string | null };
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

/** Whether a reopened thread can still be continued. */
export type ThreadScopeStatus = 'ok' | 'meeting-missing' | 'live-ended';

/** Port: saved conversations. Adapter: createChatThreadStore (platform/chat). */
export interface ChatThreadRepository {
  /** Newest first. */
  list(owner: ThreadOwner): Promise<readonly ChatThreadSummary[]>;
  get(owner: ThreadOwner, id: string): Promise<ChatThread | null>;
  save(thread: ChatThread): Promise<Result<void>>;
  rename(owner: ThreadOwner, id: string, title: string): Promise<boolean>;
  delete(owner: ThreadOwner, id: string): Promise<boolean>;
  /** The last `updatedAt` per owner, for the project cards. */
  activity(): Promise<ReadonlyMap<ThreadOwner, string>>;
}
