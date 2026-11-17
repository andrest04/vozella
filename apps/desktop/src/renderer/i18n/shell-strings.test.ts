import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';
import uiEn from './locales/ui.en.json';
import uiEs from './locales/ui.es.json';

// Every shell string exists in English and Spanish, is not empty and keeps the same placeholders.

const catalogEn = { ...en, ...uiEn } as Record<string, string>;
const catalogEs = { ...es, ...uiEs } as Record<string, string>;

const SHELL_KEYS = [
  'AppTitleBar.Title',
  'Nav_Record.Content',
  'Nav_History.Content',
  'Nav_Settings',
  'CallPrompt_Title',
  'CallPrompt_Body',
  'CallPrompt_TakeNotes',
  'MeetingPrompt_Title.Text',
  'MeetingPrompt_Subtitle.Text',
  'MeetingPrompt_Start.Content',
  'MeetingPrompt_Dismiss.Text',
  'MeetingPrompt_NeverAgain.Text',
  'SettingsLanguageRestart_Title',
  'SettingsLanguageRestart_Content',
  'SettingsLanguageRestart_RestartNow',
  'SettingsLanguageRestart_Later',
  'Settings_LanguagePicker.Header',
  'Settings_LanguagePicker.Description',
  'MeetingTitleFormat',
  'MeetingTitleDateFormat',
  'MigrationFailed_Title',
  'MigrationFailed_Content',
  'Dialog_OK',
  'AppClose_Recording_Title',
  'AppClose_Recording_Content',
  'AppClose_Recording_StopAndSave',
  'AppClose_Recording_Keep',
  'AppClose_Saving_Title',
  'AppClose_SaveFailed_Title',
  'AppClose_SaveFailed_Content',
  'AppClose_SaveFailed_CloseAnyway',
  'AppClose_SaveFailed_Stay',
  'LiveCopilot_Title',
  'LiveCopilot_StartedMessage',
  'LiveCopilot_Collapse.AutomationProperties.Name',
  'LiveCopilot_Collapse.ToolTipService.ToolTip',
] as const;

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\d+)(?::[^}]*)?\}/g)].map((match) => match[1] ?? '').sort();

describe('shell strings', () => {
  it.each(SHELL_KEYS)('%s exists in English and Spanish, not empty, same placeholders', (key) => {
    expect(catalogEn[key]?.trim(), `${key} (en)`).toBeTruthy();
    expect(catalogEs[key]?.trim(), `${key} (es)`).toBeTruthy();
    expect(placeholders(catalogEs[key] ?? ''), key).toEqual(placeholders(catalogEn[key] ?? ''));
  });
});
