import type { ShellTag, WorkspaceState } from '../library/workspace';

export type ChatScopeKind = 'AllMeetings' | 'Project' | 'Meeting' | 'Live';
export type ChatSurface = ShellTag | 'Unknown';

export interface ChatScopeDecision {
  readonly isVisible: boolean;
  readonly kind: ChatScopeKind;
  readonly projectId: string | null;
  readonly meetingId: string | null;
}

/** The scope fields of the open conversation, compared with the page's scope. */
export interface OpenThreadScope {
  readonly scopeKind: ChatScopeKind;
  readonly projectId?: string | null;
  readonly meetingId?: string | null;
}

/** Exact, case-sensitive; anything else, including null, is Unknown (spec 3.2). */
export function parseSurface(tag: string | null | undefined): ChatSurface {
  switch (tag) {
    case 'Recording':
    case 'Projects':
    case 'History':
    case 'Settings':
    case 'Session':
      return tag;
    default:
      return 'Unknown';
  }
}

/**
 * First match wins: Settings, capture active, Session with meeting, a project page, all. A
 * project page is the Projects surface with a project id; `/projects` and `/projects/none` carry
 * none, so they are All meetings.
 */
export function resolveScope(
  surface: ChatSurface,
  isCaptureActive: boolean,
  selectedProjectId: string | null,
  selectedMeetingId: string | null,
): ChatScopeDecision {
  if (surface === 'Settings') {
    return { isVisible: false, kind: 'AllMeetings', projectId: null, meetingId: null };
  }
  if (isCaptureActive) return { isVisible: true, kind: 'Live', projectId: null, meetingId: null };
  if (surface === 'Session' && selectedMeetingId !== null) {
    return { isVisible: true, kind: 'Meeting', projectId: null, meetingId: selectedMeetingId };
  }
  if ((surface === 'Projects' || surface === 'History') && selectedProjectId !== null) {
    return { isVisible: true, kind: 'Project', projectId: selectedProjectId, meetingId: null };
  }
  return { isVisible: true, kind: 'AllMeetings', projectId: null, meetingId: null };
}

/** Convenience over the shared Workspace snapshot. */
export function resolveScopeFromWorkspace(
  state: Pick<
    WorkspaceState,
    'currentShellTag' | 'isCaptureActive' | 'selectedProjectId' | 'selectedMeetingId'
  >,
): ChatScopeDecision {
  return resolveScope(
    parseSurface(state.currentShellTag),
    state.isCaptureActive,
    state.selectedProjectId,
    state.selectedMeetingId,
  );
}

/** Kind, project id and meeting id equal, with null equal to null. A mismatch never edits the thread. */
export function matchesOpenThread(thread: OpenThreadScope, decision: ChatScopeDecision): boolean {
  return (
    thread.scopeKind === decision.kind &&
    (thread.projectId ?? null) === decision.projectId &&
    (thread.meetingId ?? null) === decision.meetingId
  );
}
