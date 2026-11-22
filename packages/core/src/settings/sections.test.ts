import { describe, expect, it } from 'vitest';
import { SETTINGS_MESSAGE_KEYS, SETTINGS_SECTIONS, SETTINGS_TABS } from './sections';

describe('settings tabs', () => {
  it('are Recording, Transcription, Summaries and General, in that order', () => {
    expect(SETTINGS_TABS.map((tab) => [tab.id, tab.labelKey])).toEqual([
      ['recording', 'Ui_SettingsTabRecording'],
      ['transcription', 'Ui_SettingsTabTranscription'],
      ['summary', 'Ui_SettingsTabSummary'],
      ['general', 'Ui_SettingsTabGeneral'],
    ]);
  });

  it('group every section, without reordering the lifecycle', () => {
    const tabIds = SETTINGS_TABS.map((tab) => tab.id);
    expect(SETTINGS_SECTIONS.every((section) => tabIds.includes(section.tab))).toBe(true);
    const grouped = SETTINGS_TABS.flatMap((tab) =>
      SETTINGS_SECTIONS.filter((section) => section.tab === tab.id),
    );
    expect(grouped).toEqual(SETTINGS_SECTIONS);
  });

  it('hold the sections the owner chose for each', () => {
    const idsOf = (tab: string) =>
      SETTINGS_SECTIONS.filter((section) => section.tab === tab).map((section) => section.id);
    expect(idsOf('recording')).toEqual(['microphone', 'recording', 'callDetection']);
    expect(idsOf('transcription')).toEqual(['meetingLanguage', 'transcription']);
    expect(idsOf('summary')).toEqual(['summaryProvider']);
    expect(idsOf('general')).toEqual(['appearance', 'language', 'startup', 'data', 'about']);
  });

  it('never leave a tab empty: each has a built section', () => {
    for (const tab of SETTINGS_TABS) {
      const built = SETTINGS_SECTIONS.filter(
        (section) => section.tab === tab.id && section.status === 'built',
      );
      expect(built.length, tab.id).toBeGreaterThan(0);
    }
  });
});

describe('settings sections', () => {
  it('follow the meeting lifecycle: capture, then transcript and summary, then the app itself', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'microphone',
      'recording',
      'callDetection',
      'meetingLanguage',
      'transcription',
      'summaryProvider',
      'appearance',
      'language',
      'startup',
      'data',
      'about',
    ]);
  });

  it('About is a section of its own with a heading', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'about')?.headingKey).toBe('Ui_About');
  });

  it('this module owns the language, provider and meeting language blocks and they are built', () => {
    const own = SETTINGS_SECTIONS.filter((s) => s.owner === 'settings-i18n');
    expect(own.map((s) => s.id)).toEqual(['meetingLanguage', 'summaryProvider', 'language']);
    expect(own.every((s) => s.status === 'built')).toBe(true);
  });

  it('blocks that wait for a module are slots with a named owner', () => {
    const slots = SETTINGS_SECTIONS.filter((s) => s.status === 'slot');
    expect(slots.map((s) => [s.id, s.owner])).toEqual([['recording', 'recording']]);
  });

  it('every id and message key is unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = Object.values(SETTINGS_MESSAGE_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
