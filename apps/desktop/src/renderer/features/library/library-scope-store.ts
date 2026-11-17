import { create } from 'zustand';
import { ALL_SCOPE, type MeetingScope } from '../meeting-list/scope';

/**
 * The project the Library filters by. It is the session's own memory: the choice survives going
 * to another page and back, and is never written to disk.
 */
export const useLibraryScope = create<{ readonly scope: MeetingScope }>(() => ({
  scope: ALL_SCOPE,
}));

export function setLibraryScope(scope: MeetingScope): void {
  useLibraryScope.setState({ scope });
}
