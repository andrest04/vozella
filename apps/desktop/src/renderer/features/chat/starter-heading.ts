import type { ChatScopeKind, RecipeContext } from '@vozella/core';
import type { StringKey } from '../../i18n/translate';

/**
 * The small heading over the empty chat's starters. A meeting without action items reads as a
 * talk, a video or a class, so it is called a recording, like the content starters below it.
 */
export function starterHeadingKey(kind: ChatScopeKind, context: RecipeContext): StringKey {
  switch (kind) {
    case 'Meeting':
      return context.hasActionItems === true
        ? 'Ui_ChatStartersMeeting'
        : 'Ui_ChatStartersRecording';
    case 'Folder':
      return 'Ui_ChatStartersFolder';
    case 'Live':
      return 'Ui_ChatStartersLive';
    case 'AllMeetings':
      return 'Ui_ChatStartersLibrary';
  }
}
