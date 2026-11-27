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
 * While typing is armed or paused, every change of the status line shows a note; a refusal
 * answers a press and the stop is confirmed. While typing is off nothing else is drawn, so the
 * capsule looks as it does without the feature: a shortcut another app holds and the shortcut
 * itself (taught once per take, after the started hint closes) are only announced. `hintVisible`
 * is whether the started hint is on screen.
 */
export function useCursorTypingPill(hintVisible: boolean): CursorTypingPill {
  const t = useT();
  const status = useCursorTypingStatus();
  const note = useTimedValue<string>(CURSOR_TYPING_NOTE_MS);
  const { show } = note;
  const [announcement, setAnnouncement] = useState('');

  const stateText = status ? cursorTypingStateText(status, t) : null;
  const refusalText = status ? cursorTypingRefusalText(status.lastRefusal, t) : null;
  // Every refused press bumps it, so the same refusal twice shows its note twice.
  const refusalSeq = status?.refusalSeq ?? 0;
  const typingStatus = status?.state.status ?? 'off';
  const held = status?.shortcut.status === 'registered';
  const teachable = held && typingStatus === 'off';
  const hintText = status ? cursorTypingHint(status.shortcut.accelerator, t) : null;

  const lastTyping = useRef(typingStatus);
  useEffect(() => {
    const was = lastTyping.current;
    lastTyping.current = typingStatus;
    const stopped = was !== 'off' && typingStatus === 'off';
    const say = stateText ?? (stopped ? t('Ui_CursorTypingStopped') : null);
    if (say === null) return;
    // While typing is off the capsule stays as it was: only the stop itself is drawn.
    if (typingStatus !== 'off' || stopped) show(say);
    setAnnouncement(say);
    // Only a new line is news; `t` changes with the language and only relabels.
  }, [stateText, typingStatus, show]);

  useEffect(() => {
    if (refusalText === null) return;
    show(refusalText);
    setAnnouncement(refusalText);
  }, [refusalText, refusalSeq, show]);

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
    setAnnouncement(hintText);
  }, [hintVisible, held, teachable, hintText]);

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
