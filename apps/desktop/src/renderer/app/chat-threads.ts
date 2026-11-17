import type { ChatThreadSummaryDto } from '@vozella/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

/** What a thread is about, for the badge in a list. */
export type ThreadBadge =
  | { readonly kind: 'project' }
  | { readonly kind: 'all' }
  | { readonly kind: 'live' }
  | { readonly kind: 'meeting'; readonly title: string | null }
  | { readonly kind: 'meeting-deleted' };

/**
 * The badge of a thread. `meetingTitles` maps meeting ids to titles; null while the meetings have
 * not loaded, when nothing may be called deleted yet. A thread about a meeting that is gone still
 * lists, with its own badge, and opens read only.
 */
export function threadBadge(
  thread: Pick<ChatThreadSummaryDto, 'scope'>,
  meetingTitles: ReadonlyMap<string, string> | null,
): ThreadBadge {
  switch (thread.scope.kind) {
    case 'Project':
      return { kind: 'project' };
    case 'AllMeetings':
      return { kind: 'all' };
    case 'Live':
      return { kind: 'live' };
    case 'Meeting': {
      if (meetingTitles === null || thread.scope.meetingId === null) {
        return { kind: 'meeting', title: null };
      }
      const title = meetingTitles.get(thread.scope.meetingId);
      return title === undefined ? { kind: 'meeting-deleted' } : { kind: 'meeting', title };
    }
  }
}

const instant = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Newest activity first. */
export function sortThreads(
  threads: readonly ChatThreadSummaryDto[],
): readonly ChatThreadSummaryDto[] {
  return [...threads].sort((a, b) => instant(b.updatedAt) - instant(a.updatedAt));
}

export interface ChatThreadsModel {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly threads: readonly ChatThreadSummaryDto[];
  readonly rename: (id: string, title: string) => Promise<boolean>;
  readonly remove: (id: string) => Promise<boolean>;
}

/** The saved chats of one owner (a project, or null for no project), kept current by main. */
export function useChatThreads(owner: string | null): ChatThreadsModel {
  const [status, setStatus] = useState<ChatThreadsModel['status']>('loading');
  const [threads, setThreads] = useState<readonly ChatThreadSummaryDto[]>([]);
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const result = await window.vozella.invoke('chat.threads.list', { projectId: owner });
      if (mine !== seq.current) return;
      setThreads(sortThreads(result.threads));
      setStatus('ready');
    } catch {
      if (mine === seq.current) setStatus('failed');
    }
  }, [owner]);

  useEffect(() => {
    setStatus('loading');
    setThreads([]);
    void load();
    const off = window.vozella.on('chat.threads.changed', (event) => {
      if (event.projectId === owner) void load();
    });
    return () => {
      off();
      seq.current += 1;
    };
  }, [owner, load]);

  return {
    status,
    threads,
    rename: async (id, title) => {
      try {
        const { ok } = await window.vozella.invoke('chat.threads.rename', {
          projectId: owner,
          id,
          title,
        });
        if (ok) await load();
        return ok;
      } catch {
        return false;
      }
    },
    remove: async (id) => {
      try {
        const { ok } = await window.vozella.invoke('chat.threads.delete', { projectId: owner, id });
        if (ok) await load();
        return ok;
      } catch {
        return false;
      }
    },
  };
}
