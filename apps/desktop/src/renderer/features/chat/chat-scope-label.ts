import type { ChatScopeDecision, ChatScopeKind } from '@vozella/core';
import { Briefcase, FileText, Layers, Radio, type LucideIcon } from 'lucide-react';
import type { Translate } from '../../i18n/translate';

/** Four distinct glyphs, one for each scope. */
export const SCOPE_ICON: Readonly<Record<ChatScopeKind, LucideIcon>> = {
  Live: Radio,
  Meeting: FileText,
  Project: Briefcase,
  AllMeetings: Layers,
};

/** The name is a meeting title or a project name. Blank counts as missing. */
export function scopeLabel(
  t: Translate,
  decision: Pick<ChatScopeDecision, 'isVisible' | 'kind'>,
  name: string | null,
): string {
  if (!decision.isVisible) return '';
  const named = name !== null && name.trim() !== '' ? name : null;
  switch (decision.kind) {
    case 'Live':
      return t('Chat_ScopeLive');
    case 'Meeting':
      return named === null ? t('Chat_ScopeMeeting') : t('Chat_ScopeMeetingNamed', named);
    case 'Project':
      return named === null ? t('Chat_ScopeFolder') : t('Chat_ScopeFolderNamed', named);
    case 'AllMeetings':
      return t('Chat_ScopeAll');
  }
}
