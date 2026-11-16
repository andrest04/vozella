import { SETTINGS_TABS, type SettingsTabId } from '@vozella/core';
import { useEffect, useState } from 'react';
import {
  onTranscriptionFocus,
  pendingTranscriptionFocus,
} from '../transcription/transcription-focus';
import { onEngineFocus, pendingEngineFocus } from './engine-focus';

const FIRST_TAB: SettingsTabId = SETTINGS_TABS[0]?.id ?? 'recording';

/**
 * The tab the page was last on, kept so a revisit opens it again. It lasts as long as the window,
 * like the kept page snapshot.
 */
let lastTab: SettingsTabId = FIRST_TAB;

/** Opens the next visit on `tab`. */
export function rememberSettingsTab(tab: SettingsTabId): void {
  lastTab = tab;
}

/** Forgets the kept tab, so the next visit opens on the first one (tests). */
export function resetSettingsTab(): void {
  lastTab = FIRST_TAB;
}

/**
 * The tab a waiting link lands on. It only looks: the section that owns the target reads the
 * request once it is on screen, and then opens, scrolls and takes the focus as it always did.
 */
function linkedTab(): SettingsTabId | null {
  if (pendingEngineFocus() !== null) return 'summary';
  return pendingTranscriptionFocus() !== null ? 'transcription' : null;
}

/**
 * The tab on screen and how to change it. A link into Settings wins over the kept tab, on the
 * way in or while the page is already on screen.
 */
export function useSettingsTab(): readonly [SettingsTabId, (tab: SettingsTabId) => void] {
  const [tab, setTab] = useState<SettingsTabId>(() => linkedTab() ?? lastTab);

  useEffect(() => {
    rememberSettingsTab(tab);
  }, [tab]);

  useEffect(() => {
    const offEngine = onEngineFocus(() => {
      setTab('summary');
    });
    const offTranscription = onTranscriptionFocus(() => {
      setTab('transcription');
    });
    return () => {
      offEngine();
      offTranscription();
    };
  }, []);

  return [tab, setTab];
}
