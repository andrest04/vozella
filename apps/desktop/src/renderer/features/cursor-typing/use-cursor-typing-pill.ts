import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { useTimedValue } from '../record/use-timed-value';
import {
  cursorTypingHint,
  cursorTypingRefusalText,
  cursorTypingStateText,
  cursorTypingTargetText,
} from './cursor-typing-text';
import { useCursorTypingStatus } from './use-cursor-typing-status';

/** How long a note stays over the capsule: long enough to read, short enough to stay calm. */
export const CURSOR_TYPING_NOTE_MS = 4000;

export interface CursorTypingBadge {
  /** `paused` also covers armed without a microphone: nothing reaches the field either way. */
  readonly mode: 'armed' | 'paused';
  /** The lasting status line, the mark's tooltip. */
  readonly label: string;
}

export interface CursorTypingPill {
  /** The mark on the logo tile while typing is armed or paused; null while off. */
  readonly badge: CursorTypingBadge | null;
  /** A short note over the capsule after a change, or null. The started hint wins over it. */
  readonly note: string | null;
  /** The last thing said, for a polite live region; it stays so a repeat is not re-read. */
  readonly announcement: string;
}

/**
 * Type at cursor on the pill: a lasting mark, a note for each change, and what to announce.
 * Every change of the status line or a new refusal shows a note. While typing is off and the
 * shortcut is held, the shortcut is taught once per take, after the started hint closes, so the
 * two never fight for the capsule. `hintVisible` is whether the started hint is on screen.
 */
export function useCursorTypingPill(hintVisible: boolean): CursorTypingPill {
  const t = useT();
  const status = useCursorTypingStatus();
  const note = useTimedValue<string>(CURSOR_TYPING_NOTE_MS);
  const { show } = note;
  const [announcement, setAnnouncement] = useState('');

  const stateText = status ? cursorTypingStateText(status, t) : null;
  const refusalText = status ? cursorTypingRefusalText(status.lastRefusal, t) : null;
  const typingStatus = status?.state.status ?? 'off';
  const held = status?.shortcut.status === 'registered';
  const teachable = held && typingStatus === 'off';
  const hintText = status ? cursorTypingHint(status.shortcut.accelerator, t) : null;

  const lastTyping = useRef(typingStatus);
  useEffect(() => {
    const was = lastTyping.current;
    lastTyping.current = typingStatus;
    let say: string | null = stateText;
    if (say === null && was !== 'off' && typingStatus === 'off') say = t('Ui_CursorTypingStopped');
    if (say === null) return;
    show(say);
    setAnnouncement(say);
    // Only a new line is news; `t` changes with the language and only relabels.
  }, [stateText, typingStatus, show]);

  useEffect(() => {
    if (refusalText === null) return;
    show(refusalText);
    setAnnouncement(refusalText);
  }, [refusalText, show]);

  // Per take: the shortcut is let go when the take ends, which starts the next lesson afresh.
  const hintSeen = useRef(false);
  const taught = useRef(false);
  const wasHeld = useRef(held);
  useEffect(() => {
    if (wasHeld.current && !held) {
      hintSeen.current = false;
      taught.current = false;
    }
    wasHeld.current = held;
    if (hintVisible) {
      hintSeen.current = true;
      return;
    }
    if (!teachable || !hintSeen.current || taught.current || hintText === null) return;
    taught.current = true;
    show(hintText);
    setAnnouncement(hintText);
  }, [hintVisible, held, teachable, hintText, show]);

  const state = status?.state ?? null;
  const targetText = state ? cursorTypingTargetText(state, t) : null;
  const badge: CursorTypingBadge | null =
    state === null || state.status === 'off' || targetText === null
      ? null
      : {
          mode: state.status === 'armed' && state.warning === null ? 'armed' : 'paused',
          label: targetText,
        };

  return { badge, note: note.value, announcement };
}
