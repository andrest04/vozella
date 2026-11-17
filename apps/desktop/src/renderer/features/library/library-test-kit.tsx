import { useEffect } from 'react';
import { connectMeetingList } from '../meeting-list/meeting-list-store';
import { connectProjectDirectory } from '../meeting-list/project-directory';
import { LibraryRoute } from './LibraryRoute';

export * from '../meeting-list/meeting-list-test-kit';

/** The Library as the shell shows it: the connected stores and the route. */
export function LibraryScreen() {
  useEffect(() => connectMeetingList(), []);
  useEffect(() => connectProjectDirectory(), []);
  return <LibraryRoute />;
}
