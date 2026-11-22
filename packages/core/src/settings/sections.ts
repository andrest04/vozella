/**
 * The blocks of the Settings page, top to bottom, and who owns each. The page is a
 * frame: it draws these in order and each owner mounts its own content in its slot. A `slot`
 * block has no content until its module lands; the page shows nothing in its place.
 */

export type SettingsSectionId =
  | 'appearance'
  | 'language'
  | 'summaryProvider'
  | 'microphone'
  | 'meetingLanguage'
  | 'transcription'
  | 'recording'
  | 'callDetection'
  | 'startup'
  | 'data'
  | 'about';

/** The tabs of the Settings page. Each one shows a short group of sections. */
export type SettingsTabId = 'recording' | 'transcription' | 'summary' | 'general';

export interface SettingsTab {
  readonly id: SettingsTabId;
  /** Catalog key of the tab's label, in `locales/ui.{en,es}.json`. */
  readonly labelKey: `Ui_SettingsTab${Capitalize<SettingsTabId>}`;
}

/** The tabs, left to right, in the same lifecycle order as the sections they hold. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'recording', labelKey: 'Ui_SettingsTabRecording' },
  { id: 'transcription', labelKey: 'Ui_SettingsTabTranscription' },
  { id: 'summary', labelKey: 'Ui_SettingsTabSummary' },
  { id: 'general', labelKey: 'Ui_SettingsTabGeneral' },
];

export interface SettingsSection {
  readonly id: SettingsSectionId;
  /** The tab that shows the block (owner decision 2026-11-15). */
  readonly tab: SettingsTabId;
  /** Catalog key of the heading, or null when the block is a single row with its own header. */
  readonly headingKey: string | null;
  /** The module that owns the content and the fields it writes. */
  readonly owner: string;
  /** `built`: the services behind it exist. `slot`: waiting for its module. */
  readonly status: 'built' | 'slot';
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // The meeting lifecycle (owner decision 2026-11-05): what is captured, what is
  // made of it, then the app itself. The theme is a shell setting of its own.
  {
    id: 'microphone',
    tab: 'recording',
    headingKey: 'Settings_Microphone.Text',
    owner: 'audio-capture',
    status: 'built',
  },
  {
    id: 'recording',
    tab: 'recording',
    headingKey: 'Settings_Recording.Text',
    owner: 'recording',
    status: 'slot',
  },
  {
    id: 'callDetection',
    tab: 'recording',
    headingKey: 'Ui_CallDetection',
    owner: 'calendar-detection',
    status: 'built',
  },
  {
    id: 'meetingLanguage',
    tab: 'transcription',
    headingKey: 'Settings_MeetingLanguage.Text',
    owner: 'settings-i18n',
    status: 'built',
  },
  {
    id: 'transcription',
    tab: 'transcription',
    headingKey: 'Settings_Transcription.Text',
    owner: 'transcription',
    status: 'built',
  },
  {
    id: 'summaryProvider',
    tab: 'summary',
    headingKey: 'Settings_SummaryProvider.Text',
    owner: 'settings-i18n',
    status: 'built',
  },
  {
    id: 'appearance',
    tab: 'general',
    headingKey: 'Ui_Appearance',
    owner: 'shell-platform',
    status: 'built',
  },
  {
    id: 'language',
    tab: 'general',
    headingKey: 'Settings_Language.Text',
    owner: 'settings-i18n',
    status: 'built',
  },
  {
    id: 'startup',
    tab: 'general',
    headingKey: 'Ui_Startup',
    owner: 'shell-platform',
    status: 'built',
  },
  {
    id: 'data',
    tab: 'general',
    headingKey: 'Settings_Data.Text',
    owner: 'library-storage',
    status: 'built',
  },
  {
    id: 'about',
    tab: 'general',
    headingKey: 'Ui_About',
    owner: 'library-storage',
    status: 'built',
  },
];

/**
 * Catalog keys the Settings page uses that are not part of the base catalog, so the page names them from
 * one place. All are in `locales/ui.{en,es}.json`.
 */
export const SETTINGS_MESSAGE_KEYS = {
  loadFailed: 'Ui_SettingsLoadFailed',
  loading: 'Ui_SettingsLoading',
  saveFailed: 'Ui_SettingsSaveFailed',
  recovered: 'Ui_SettingsRecovered',
  modelDownloadFailed: 'Ui_ModelDownloadFailed',
  modelDeleteFailed: 'Ui_ModelDeleteFailed',
  modelDeleteBusy: 'Ui_ModelDeleteBusy',
  modelMissing: 'Ui_ModelMissing',
  modelCancelDownload: 'Ui_ModelCancelDownload',
  restartFailed: 'Ui_RestartFailed',
  cliCheckAgain: 'Ui_CliCheckAgain',
  xaiRetry: 'Ui_XaiRetry',
  providerXaiRemoved: 'Ui_SummaryProviderXaiRemoved',
  tabsLabel: 'Ui_SettingsTabsLabel',
  /** Accessible names written in English only. The owning modules use them. */
  micLevelName: 'Ui_MicLevelName',
  engineDownloadProgressName: 'Ui_EngineDownloadProgressName',
  speakerDownloadProgressName: 'Ui_SpeakerDownloadProgressName',
} as const;
