import { useEffect } from 'react';
import { connectLibrary } from '../meeting-list/meeting-list-store';
import { LibraryFolders } from './LibraryFolders';
import { LibraryRoute } from './LibraryRoute';

export * from '../meeting-list/meeting-list-test-kit';

/** The Library as the shell shows it: the connected store, the sidebar tree and the route. */
export function LibraryScreen() {
  useEffect(() => connectLibrary(), []);
  return (
    <>
      <LibraryFolders location="library" />
      <LibraryRoute />
    </>
  );
}
