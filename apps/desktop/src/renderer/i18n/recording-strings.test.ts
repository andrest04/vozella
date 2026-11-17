import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';
import uiEn from './locales/ui.en.json';
import uiEs from './locales/ui.es.json';

// The strings and the control names of the Record page exist in both languages. The page reads
// the converted keys and the hand-written `Ui_` keys from one merged catalog.
const catalogEn: Record<string, string> = { ...en, ...uiEn };
const catalogEs: Record<string, string> = { ...es, ...uiEs };

const RECORD_KEYS = [
  'RecordPage_MeetingTitle.Header',
  'RecordPage_Destination.Header',
  'RecordPage_SourcesHeading.Text',
  'RecordPage_MicrophoneNone',
  'Microphone_SystemDefault',
  'RecordPage_AllSystemAudio.Text',
  'RecordPage_SystemCardTooltip',
  'RecordPage_AppCardTooltip',
  'RecordPage_AppDetectedTag.Text',
  'RecordPage_BrowserHint.Text',
  'RecordPage_AppNotPlaying.Text',
  'RecordPage_NoAppsPlaying.Text',
  'RecordPage_SuggestionTitle',
  'RecordPage_SuggestionAction',
  'RecordPage_SourceFallbackMessage',
  'RecordPage_SourcesSummary',
  'RecordingSetup_Headline.Text',
  'RecordingSetup_SetUpToRecord.Content',
  'RecordingSetup.Title',
  'RecordingSetup_Live.Header',
  'RecordingSetup_NotNeeded',
  'RecordingSetup_Ready',
  'RecordingSetup_NeedsSetup',
  'RecordingSetup_LiveDetail',
  'RecordingSetup_LiveNotNeededDetail',
  'RecordingSetup_Engine.Header',
  'RecordingSetup_EngineDetail',
  'RecordingSetup_Summary.Header',
  'RecordingSetup_SummaryNotChosen',
  'RecordingSetup_SummaryLocal',
  'RecordingSetup_SummaryLocalModel',
  'Cli_ClaudeName',
  'Cli_CodexName',
  'Xai_ProviderName',
  'RecordingSetup_Done',
  'RecordingSetup_SetUp',
  'Status_LoadingModel',
  'Error_StopRecording',
  'RecordPage_LiveBadge.Text',
  'RecordPage_LiveTranscriptHint.Text',
  'RecordPage_JumpToLatest',
  'RecordPage_LiveQuestionNotice.Title',
  'RecordPage_LiveAnswer.Content',
  'RecordPage_LiveAnswerDismiss.Content',
  'RecordPage_LiveAnswerError.Title',
  'LiveCopilot_WebTooltipOn',
  'LiveCopilot_WebTooltipOff',
  'RecordPage_WebBadge.Text',
  'LiveCopilot_PromptMissed',
  'LiveCopilot_PromptExplain',
  'Status_SetupCancelled',
  'LiveCopilot_NeedsSetup',
  'RecordPage_LiveAnswerEmpty',
  'RecordPage_SessionNotes.Header',
  'RecordPage_SessionNotes.PlaceholderText',
  'RecordPage_CancelProcessing.Content',
  'Status_Transcribing',
  'Status_TranscribingPercent',
  'Status_GeneratingSummary',
  'Status_CancelledTranscriptSaved',
  'Status_ProcessingCancelled',
  'Record_Import',
  'Ui_ImportYouTube',
  'Ui_ImportYouTubeTitle',
  'Ui_ImportYouTubeLabel',
  'Ui_ImportYouTubePlaceholder',
  'Ui_ImportYouTubeCancel',
  'Ui_ImportYouTubeSubmit',
  'Ui_ErrorYouTubeUrl',
  'Ui_StatusDownloadingYouTube',
  'Ui_ErrorYtDlpInstall',
  'Ui_ErrorYouTubeDownload',
  'RecordPage_Open.Content',
  'RecordPage_BriefHeading.Text',
  'RecordPage_BriefFailed.Title',
  'RecordPage_BriefFailedFormat',
  'LiveCopilot_StartedMessage',
  'AppClose_Recording_Title',
  'AppClose_Recording_Content',
  'AppClose_Saving_Title',
  'AppClose_SaveFailed_Title',
  'AppClose_SaveFailed_Content',
  'Error_OutputCaptureFailed',
  'Error_CaptureFaulted',
  'Warning_MicrophoneLost',
  'Warning_OutputAudioLost',
  'Warning_NoAudioSourcesLeft',
  'RecordPage_StatusErrorTitle.Title',
] as const;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('Record page strings', () => {
  it.each(RECORD_KEYS)('%s exists in English and Spanish with the same placeholders', (key) => {
    expect(catalogEn[key], `${key} in en`).toBeDefined();
    expect(catalogEs[key], `${key} in es`).toBeDefined();
    expect(placeholders(catalogEs[key] ?? '')).toEqual(placeholders(catalogEn[key] ?? ''));
  });

  it('every key of the Record page shared by both catalogs has the same placeholders', () => {
    const shared = Object.keys(catalogEn).filter(
      (key) => key in catalogEs && /^(RecordPage_|Status_|Error_|Ui_Record)/.test(key),
    );
    for (const key of shared) {
      expect(placeholders(catalogEs[key] ?? ''), key).toEqual(placeholders(catalogEn[key] ?? ''));
    }
  });
});

/**
 * Each control of the Record page and where the app keeps it. The automation id is a `data-testid`;
 * the toggle is two buttons, Record and Stop. A name that is an accessible-name resource key is
 * checked in the catalog instead.
 */
const controls: { name: string; target: string; file: string; kind: 'testid' | 'key' }[] = [
  {
    name: 'BtnToggleRecording',
    target: 'BtnRecord',
    file: 'features/record/RecordRoute.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnToggleRecording',
    target: 'BtnStop',
    file: 'features/record/RecordingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnPauseRecording',
    target: 'BtnPause',
    file: 'features/record/RecordingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnHighlightMoment',
    target: 'BtnHighlight',
    file: 'features/record/RecordingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnCopyLiveTranscript',
    target: 'BtnCopy',
    file: 'features/record/RecordingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnDiscardRecording',
    target: 'BtnDiscard',
    file: 'features/record/RecordingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnImportAudio',
    target: 'BtnImportAudio',
    file: 'features/record/RecordRoute.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnCancelProcessing',
    target: 'BtnCancelProcessing',
    file: 'features/record/ProcessingBar.tsx',
    kind: 'testid',
  },
  {
    name: 'BtnOpenSession',
    target: 'BtnOpenResult',
    file: 'features/record/ResultCard.tsx',
    kind: 'testid',
  },
  {
    name: 'TxtMeetingTitle',
    target: 'TxtMeetingTitle',
    file: 'features/record/RecordIdle.tsx',
    kind: 'testid',
  },
  {
    name: 'ComboRecordDestination',
    target: 'CmbDestination',
    file: 'features/record/RecordIdle.tsx',
    kind: 'testid',
  },
  {
    name: 'ComboRecordMicrophone',
    target: 'ComboRecordMicrophone.AutomationProperties.Name',
    file: '',
    kind: 'key',
  },
  {
    name: 'ListRecordAudioSource',
    target: 'ListRecordAudioSource.AutomationProperties.Name',
    file: '',
    kind: 'key',
  },
  {
    name: 'TxtRecordingNotes',
    target: 'TxtRecordingNotes',
    file: 'features/record/notepad/Notepad.tsx',
    kind: 'testid',
  },
  {
    name: 'TxtLiveAsk',
    target: 'TxtLiveAsk',
    file: 'features/record/LiveAskDock.tsx',
    kind: 'testid',
  },
  {
    name: 'ToggleLiveWebSearch',
    target: 'ToggleLiveWebSearch',
    file: 'features/record/LiveAskDock.tsx',
    kind: 'testid',
  },
  {
    name: 'TxtLiveTranscriptPreview',
    target: 'live-canvas',
    file: 'features/record/LiveCanvas.tsx',
    kind: 'testid',
  },
];

describe('automation ids of the Record page', () => {
  it.each(controls)('$name is $target', (control) => {
    if (control.kind === 'key') {
      expect(catalogEn[control.target]).toBeDefined();
      expect(catalogEs[control.target]).toBeDefined();
      return;
    }
    const source = fs.readFileSync(path.resolve(__dirname, '..', control.file), 'utf8');
    expect(source).toMatch(
      new RegExp(`(data-testid|testId|id)["']?[=:]\\s*["{']+${control.target}["'}]`),
    );
  });
});
