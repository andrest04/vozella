import type { ChatStateDto, WorkspaceStateDto } from '@vozella/contracts';
import { resolveScopeFromWorkspace, type ChatScopeDecision } from '@vozella/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecordingStore } from '../record/use-recording';

/** Why a reopened thread cannot be continued; null when it can. */
export type ThreadReadOnly = 'meeting-missing' | 'live-ended' | null;

export interface PinnedThread {
  readonly decision: ChatScopeDecision;
  readonly readOnly: ThreadReadOnly;
}

export interface ChatScopeView {
  /** What the panel shows and sends under: the pinned thread's scope, else the page's. */
  readonly decision: ChatScopeDecision;
  /** Meeting title or project name once looked up; null while unknown or when it does not exist. */
  readonly name: string | null;
  /** Whose saved chats the History lists: the project, or null for no project. */
  readonly owner: string | null;
  readonly canStartNewChat: boolean;
  /** False when saving the history failed or storage is read only: the chat goes on unsaved. */
  readonly historySaved: boolean;
  readonly pinned: PinnedThread | null;
  /**
   * Pins the scope of a reopened thread. It holds until the page changes, New chat is chosen, or
   * another thread is opened.
   */
  readonly pin: (thread: PinnedThread) => void;
  readonly unpin: () => void;
}

const HIDDEN: ChatScopeDecision = {
  isVisible: false,
  kind: 'AllMeetings',
  projectId: null,
  meetingId: null,
};

interface Lookup {
  readonly name: string | null;
  /** The project the scope belongs to: its own for a project, the meeting's for a meeting. */
  readonly owner: string | null;
}

async function lookup(decision: ChatScopeDecision): Promise<Lookup> {
  if (decision.kind === 'Meeting' && decision.meetingId !== null) {
    const { record } = await window.vozella.invoke('library.getMeeting', {
      id: decision.meetingId,
    });
    return { name: record?.title ?? null, owner: record?.projectId ?? decision.projectId };
  }
  if (decision.kind === 'Project' && decision.projectId !== null) {
    const listed = await window.vozella.invoke('projects.list', {});
    const name = listed.projects.find((project) => project.id === decision.projectId)?.name ?? null;
    return { name, owner: decision.projectId };
  }
  return { name: null, owner: decision.projectId };
}

function same(a: ChatScopeDecision | null, b: ChatScopeDecision): boolean {
  return (
    a !== null &&
    a.isVisible === b.isVisible &&
    a.kind === b.kind &&
    a.projectId === b.projectId &&
    a.meetingId === b.meetingId
  );
}

/**
 * The scope the AI panel shows, from the workspace state main pushes (parity 1 to 11, 18). Each
 * refresh starts a new generation, so a name lookup that finishes late is discarded.
 *
 * A reopened thread pins its own scope over the page's. Main still hears the page's scope, so its
 * mismatch notice explains when the two differ, and the pin ends when the page changes.
 */
export function useChatScope(): ChatScopeView {
  const [page, setPage] = useState<ChatScopeDecision>(HIDDEN);
  const [pinned, setPinned] = useState<PinnedThread | null>(null);
  const [found, setFound] = useState<{ readonly key: string; readonly lookup: Lookup } | null>(
    null,
  );
  const [tick, setTick] = useState(0);
  const [canStartNewChat, setCanStartNewChat] = useState(false);
  const [historySaved, setHistorySaved] = useState(true);
  const generation = useRef(0);
  /** The page decision last shown, and the one last delivered to main. */
  const last = useRef<ChatScopeDecision | null>(null);
  const delivered = useRef<ChatScopeDecision | null>(null);
  const takeProject = useRecordingStore((state) => state.projectId);

  const decision = pinned?.decision ?? page;
  const key = `${String(decision.isVisible)}|${decision.kind}|${String(decision.projectId)}|${String(decision.meetingId)}`;

  useEffect(() => {
    let disposed = false;
    const applyChat = (chat: Pick<ChatStateDto, 'canStartNewChat' | 'historySaved'>): void => {
      setCanStartNewChat(chat.canStartNewChat);
      setHistorySaved(chat.historySaved);
    };
    const refresh = async (known?: WorkspaceStateDto): Promise<void> => {
      generation.current += 1;
      const mine = generation.current;
      const stale = (): boolean => disposed || mine !== generation.current;
      const state = known ?? (await window.vozella.invoke('workspace.getState', {}));
      if (stale()) return;
      const next = resolveScopeFromWorkspace(state);
      const changed = !same(last.current, next);
      const first = last.current === null;
      last.current = next;
      if (changed) {
        setPage(next);
        // Going to another page ends the pin of a reopened thread.
        if (!first) setPinned(null);
      }
      // Main must hear the final scope even when a later refresh makes this one stale, so the
      // delivery is tracked on its own and is not gated by the generation.
      if (!same(delivered.current, next)) {
        delivered.current = next;
        void window.vozella
          .invoke('chat.setScope', { scope: next })
          .then((chat) => {
            if (!disposed && same(delivered.current, next)) applyChat(chat);
          })
          .catch(() => {
            if (same(delivered.current, next)) delivered.current = null;
          });
      }
      // A rename arrives as the same decision, so the name is looked up again on every refresh.
      setTick((value) => value + 1);
    };
    const run = (state?: WorkspaceStateDto): void => {
      void refresh(state).catch(() => undefined);
    };
    run();
    // Live transcript text changes arrive here too; they never change the scope, so skip them.
    const offWorkspace = window.vozella.on('workspace.changed', ({ state }) => {
      if (same(last.current, resolveScopeFromWorkspace(state))) return;
      run(state);
    });
    const offLibrary = window.vozella.on('library.changed', () => {
      run();
    });
    const offProjects = window.vozella.on('projects.changed', () => {
      setTick((value) => value + 1);
    });
    const offChat = window.vozella.on('chat.stateChanged', ({ state }) => {
      applyChat(state);
    });
    return () => {
      disposed = true;
      offWorkspace();
      offLibrary();
      offProjects();
      offChat();
    };
  }, []);

  // The name and owner of whatever the panel shows, for the label and for the History.
  useEffect(() => {
    let stale = false;
    void lookup(decision)
      .then((result) => {
        if (!stale) setFound({ key, lookup: result });
      })
      .catch(() => {
        if (!stale) setFound({ key, lookup: { name: null, owner: decision.projectId } });
      });
    return () => {
      stale = true;
    };
    // The decision is described by its key.
  }, [key, tick]);

  const current = found?.key === key ? found.lookup : null;
  const owner =
    decision.kind === 'Live'
      ? takeProject
      : decision.kind === 'Meeting'
        ? (current?.owner ?? null)
        : decision.projectId;

  const pin = useCallback((thread: PinnedThread): void => {
    setPinned(thread);
  }, []);
  const unpin = useCallback((): void => {
    setPinned(null);
  }, []);

  return {
    decision,
    name: current?.name ?? null,
    owner,
    canStartNewChat,
    historySaved,
    pinned,
    pin,
    unpin,
  };
}
