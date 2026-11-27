import { describe, expect, it } from 'vitest';
import { LibraryFileCorruptError } from './errors';
import {
  applySettingsPatch,
  parseSettingsJson,
  readSettings,
  DEFAULT_CURSOR_TYPING_SHORTCUT,
  resolveClaudeEffort,
  resolveClaudeModelId,
  resolveCursorTypingShortcut,
  resolveCursorTypingSource,
  resolveCodexEffort,
  resolveCodexModelId,
  resolveLiveQuestionsMode,
  resolveSummaryLanguage,
  resolveSummaryProviderKind,
  resolveTranscriptionLanguage,
  isProviderAvailable,
  serializeSettings,
  type AppSettings,
} from './settings';

const defaults = readSettings({});
const parseObject = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

describe('defaults', () => {
  it('matches the settings table', () => {
    expect(defaults).toEqual<AppSettings>({
      selectedSummaryModelId: null,
      selectedSummaryProvider: null,
      selectedClaudeModelId: null,
      selectedClaudeEffort: null,
      selectedCodexModelId: null,
      selectedCodexEffort: null,
      transcriptionLanguage: null,
      summaryLanguage: null,
      selectedMicrophoneDeviceId: null,
      recordMicrophoneKind: null,
      recordMicrophoneDeviceId: null,
      recordOutputKind: null,
      recordAppExePath: null,
      recordAppName: null,
      liveTranscriptionEnabled: true,
      speakerDiarizationEnabled: false,
      meetingPopupEnabled: true,
      uiLanguage: null,
      liveCopilotPillEdge: null,
      liveCopilotPillAlong: null,
      liveQuestions: null,
      selectedOpenAiModelId: null,
      selectedAnthropicModelId: null,
      selectedGeminiModelId: null,
      selectedOpenAiCompatibleModelId: null,
      openAiCompatibleBaseUrl: null,
      selectedGroqModelId: null,
      transcriptionEngine: null,
      cloudTranscriptionModelId: null,
      customNoteTemplate: null,
      openAtLogin: false,
      cursorTypingEnabled: true,
      cursorTypingShortcut: null,
      cursorTypingSource: null,
    });
  });

  it('keeps true booleans true and false booleans false when the JSON omits them', () => {
    const read = readSettings({ uiLanguage: 'es' });
    expect(read.meetingPopupEnabled).toBe(true);
    expect(read.liveTranscriptionEnabled).toBe(true);
    expect(read.speakerDiarizationEnabled).toBe(false);
  });

  it('round-trips false for the true-default booleans', () => {
    const read = readSettings(
      parseObject(
        serializeSettings(
          applySettingsPatch(
            {},
            {
              meetingPopupEnabled: false,
            },
          ),
        ),
      ),
    );
    expect(read.meetingPopupEnabled).toBe(false);
  });
});

describe('resolvers', () => {
  it('languages default to es and keep pinned values', () => {
    expect(resolveTranscriptionLanguage(defaults)).toBe('es');
    expect(resolveSummaryLanguage(defaults)).toBe('es');
    expect(resolveTranscriptionLanguage({ ...defaults, transcriptionLanguage: 'en' })).toBe('en');
    expect(resolveSummaryLanguage({ ...defaults, summaryLanguage: ' ' })).toBe('es');
  });

  it('provider model and effort defaults', () => {
    expect(resolveClaudeModelId(defaults)).toBe('sonnet');
    expect(resolveClaudeEffort(defaults)).toBe('low');
    expect(resolveCodexModelId(defaults)).toBe('gpt-5.6');
    expect(resolveCodexEffort(defaults)).toBe('low');
    expect(resolveClaudeModelId({ ...defaults, selectedClaudeModelId: 'opus' })).toBe('opus');
  });

  it('stored blank or whitespace values resolve to the defaults', () => {
    for (const blankValue of ['', '  ']) {
      expect(resolveClaudeModelId({ ...defaults, selectedClaudeModelId: blankValue })).toBe(
        'sonnet',
      );
      expect(resolveClaudeEffort({ ...defaults, selectedClaudeEffort: blankValue })).toBe('low');
      expect(resolveCodexModelId({ ...defaults, selectedCodexModelId: blankValue })).toBe(
        'gpt-5.6',
      );
      expect(resolveCodexEffort({ ...defaults, selectedCodexEffort: blankValue })).toBe('low');
      expect(resolveSummaryProviderKind({ ...defaults, selectedSummaryProvider: blankValue })).toBe(
        'Local',
      );
    }
  });

  it('summary provider parses case-sensitively and defaults to Local', () => {
    const p = (value: string | null) =>
      resolveSummaryProviderKind({ ...defaults, selectedSummaryProvider: value });
    expect(p(null)).toBe('Local');
    expect(p('Codex')).toBe('Codex');
    expect(p('ClaudeCode')).toBe('ClaudeCode');
    expect(p('codex')).toBe('Local');
    expect(p('nonsense')).toBe('Local');
  });

  it('a legacy Xai provider stays Xai, is unavailable, and is never mapped to Local', () => {
    const read = { ...defaults, selectedSummaryProvider: 'Xai' };
    expect(resolveSummaryProviderKind(read)).toBe('Xai');
    expect(isProviderAvailable('Xai')).toBe(false);
    for (const kind of ['Local', 'ClaudeCode', 'Codex'] as const) {
      expect(isProviderAvailable(kind)).toBe(true);
    }
  });

  it('a legacy Xai file loads and keeps its provider, its old xai fields and unknown fields through a re-save', () => {
    const text = JSON.stringify(
      {
        selectedSummaryProvider: 'Xai',
        selectedXaiModelId: 'grok-4.3',
        selectedXaiEffort: 'high',
        futureField: { a: 1 },
        summaryLanguage: 'en',
      },
      null,
      2,
    );
    const parsed = parseSettingsJson(text);
    expect(parsed.settings.selectedSummaryProvider).toBe('Xai');
    expect(parsed.settings).not.toHaveProperty('selectedXaiModelId');
    expect(parsed.settings).not.toHaveProperty('selectedXaiEffort');
    expect(parsed.raw).toMatchObject({ selectedXaiModelId: 'grok-4.3', selectedXaiEffort: 'high' });
    const rewritten = serializeSettings(applySettingsPatch(parsed.raw, { summaryLanguage: 'es' }));
    expect(rewritten).toContain('"selectedSummaryProvider": "Xai"');
    expect(rewritten).toContain('"selectedXaiModelId": "grok-4.3"');
    expect(rewritten).toContain('"selectedXaiEffort": "high"');
    expect(rewritten).toContain('"futureField"');
    const unchanged = serializeSettings(applySettingsPatch(parsed.raw, {}));
    expect(JSON.parse(unchanged)).toMatchObject(JSON.parse(text) as object);
  });

  it('numeric text does not parse as a provider', () => {
    for (const text of ['0', '1', '99', '-1']) {
      expect(resolveSummaryProviderKind({ ...defaults, selectedSummaryProvider: text })).toBe(
        'Local',
      );
    }
  });

  it('pill dock round-trips through a write, and unset reads as null', () => {
    const text = serializeSettings(
      applySettingsPatch({}, { liveCopilotPillEdge: 'Top', liveCopilotPillAlong: 0.25 }),
    );
    const read = parseSettingsJson(text).settings;
    expect(read.liveCopilotPillEdge).toBe('Top');
    expect(read.liveCopilotPillAlong).toBe(0.25);
    expect(defaults.liveCopilotPillEdge).toBeNull();
    expect(defaults.liveCopilotPillAlong).toBeNull();
  });

  it('removed chat keys are ignored and a stored Codex provider still resolves to Codex', () => {
    const read = parseSettingsJson(
      '{"selectedChatProvider":"Claude","selectedLiveAnswerProvider":"Xai","selectedSummaryProvider":"Codex"}',
    ).settings;
    expect(resolveSummaryProviderKind(read)).toBe('Codex');
    expect(Object.keys(read)).not.toContain('selectedChatProvider');
  });
});

describe('reading and writing', () => {
  it('accepts numbers written as strings', () => {
    expect(readSettings({ liveCopilotPillAlong: '0.3' }).liveCopilotPillAlong).toBe(0.3);
  });

  it('parses case-insensitive names and ignores removed provider keys', () => {
    const read = parseSettingsJson(
      '{"UILanguage":"en","removedProviderKey":"x","summaryLanguage":"en"}',
    );
    expect(read.settings.summaryLanguage).toBe('en');
    expect(read.settings.uiLanguage).toBe('en');
  });

  it('a missing or null document is the defaults', () => {
    expect(parseSettingsJson('null').settings).toEqual(defaults);
  });

  it('a corrupt file raises a typed error', () => {
    expect(() => parseSettingsJson('{oops')).toThrow(LibraryFileCorruptError);
    expect(() => parseSettingsJson('[1]')).toThrow(LibraryFileCorruptError);
    expect(() => parseSettingsJson('')).toThrow(LibraryFileCorruptError);
  });

  it('writes every property in declaration order, plain UTF-8 with LF', () => {
    const text = serializeSettings({});
    expect(text.split('\n')[1]).toBe('  "selectedSummaryModelId": null,');
    expect(text).toContain('  "meetingPopupEnabled": true,');
    expect(text.split('\n').at(-2)).toBe('  "liveCopilotPillAlong": null');
    expect(text).not.toContain('liveQuestions');
    expect(text).not.toContain('OpenAi');
    expect(text).not.toContain('Anthropic');
    expect(text).not.toContain('Gemini');
    expect(text).not.toContain('Groq');
    expect(text.endsWith('\n}')).toBe(true);
  });

  it('BYOK: the API engine fields are written only once set and round-trip', () => {
    const patch = {
      selectedOpenAiModelId: 'gpt-5',
      selectedAnthropicModelId: 'claude-haiku-5-5',
      selectedGeminiModelId: 'gemini-2.5-pro',
      selectedOpenAiCompatibleModelId: 'llama3.1',
      openAiCompatibleBaseUrl: 'http://localhost:11434/v1',
      selectedGroqModelId: 'openai/gpt-oss-120b',
    } as const;
    const text = serializeSettings(applySettingsPatch({}, patch));
    expect(parseSettingsJson(text).settings).toMatchObject(patch);
    const partial = serializeSettings(applySettingsPatch({}, { selectedGeminiModelId: 'g' }));
    expect(partial).toContain('"selectedGeminiModelId": "g"');
    expect(partial).not.toContain('selectedOpenAiModelId');
    expect(partial).not.toContain('openAiCompatibleBaseUrl');
  });

  it('cloud transcription: an old file is rewritten unchanged while the engine is Local', () => {
    const old = serializeSettings({ uiLanguage: 'es', selectedGroqModelId: 'openai/gpt-oss-120b' });
    expect(old).not.toContain('transcriptionEngine');
    expect(old).not.toContain('cloudTranscriptionModelId');
    const { raw, settings } = parseSettingsJson(old);
    expect(settings.transcriptionEngine).toBeNull();
    expect(settings.cloudTranscriptionModelId).toBeNull();
    // A save of something else writes the same bytes plus that change only.
    expect(serializeSettings(raw)).toBe(old);
    expect(serializeSettings(applySettingsPatch(raw, { transcriptionEngine: null }))).toBe(old);
  });

  it('cloud transcription: the engine and its model are appended last once set, and round-trip', () => {
    const patch = { transcriptionEngine: 'Groq', cloudTranscriptionModelId: 'whisper-large-v3' };
    const text = serializeSettings(
      applySettingsPatch({ selectedGroqModelId: 'openai/gpt-oss-120b' }, patch),
    );
    expect(parseSettingsJson(text).settings).toMatchObject(patch);
    const lines = text.split('\n');
    expect(lines.at(-3)).toBe('  "transcriptionEngine": "Groq",');
    expect(lines.at(-2)).toBe('  "cloudTranscriptionModelId": "whisper-large-v3"');
    expect(text.indexOf('selectedGroqModelId')).toBeLessThan(text.indexOf('transcriptionEngine'));
    const engineOnly = serializeSettings(applySettingsPatch({}, { transcriptionEngine: 'OpenAi' }));
    expect(engineOnly).toContain('"transcriptionEngine": "OpenAi"');
    expect(engineOnly).not.toContain('cloudTranscriptionModelId');
  });

  it('unknown keys survive a patch and stay after the known ones', () => {
    const merged = applySettingsPatch(
      { futureThing: { a: 1 }, uiLanguage: 'en' },
      { summaryLanguage: 'en' },
    );
    const text = serializeSettings(merged);
    expect(JSON.parse(text)).toMatchObject({
      futureThing: { a: 1 },
      uiLanguage: 'en',
      summaryLanguage: 'en',
    });
    expect(text.indexOf('futureThing')).toBeGreaterThan(text.indexOf('liveCopilotPillAlong'));
  });

  it('reads a BOM, CRLF, escaped and mixed-case file written by an earlier version and rewrites it plain', () => {
    const older = `\uFEFF{\r\n  "UiLanguage": "es",\r\n  "summaryLanguage": "\\u00E9s",\r\n  "futureThing": 1\r\n}`;
    const { settings, raw } = parseSettingsJson(older);
    expect(settings.uiLanguage).toBe('es');
    const text = serializeSettings(raw);
    expect(text).not.toContain('\r');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).not.toMatch(/\\u[0-9A-Fa-f]{4}/);
    expect(text).toContain('"summaryLanguage": "és"');
    expect(parseSettingsJson(text).settings.uiLanguage).toBe('es');
  });

  it('cd-1: a file with the dropped calendar settings, no Xai and Jev flags survives load and rewrite unchanged', () => {
    const text = serializeSettings(
      applySettingsPatch(
        {
          futureThing: { a: 1 },
          calendarNotificationsEnabled: false,
          disabledCalendarIds: ['cal-1', 'cal-2'],
        },
        {
          meetingPopupEnabled: false,
          selectedSummaryProvider: 'Codex',
          uiLanguage: 'en',
        },
      ),
    );
    const { settings, raw } = parseSettingsJson(text);
    expect(settings.meetingPopupEnabled).toBe(false);
    expect(settings).not.toHaveProperty('selectedXaiModelId');
    expect(serializeSettings(raw)).toBe(text);
    expect(serializeSettings(applySettingsPatch(raw, { summaryLanguage: 'en' }))).toContain(
      '"disabledCalendarIds": [\n    "cal-1",\n    "cal-2"\n  ]',
    );
  });

  it('cd-1: a file that still selects Xai loads and rewrites with the provider kept', () => {
    const text = serializeSettings(
      applySettingsPatch({ selectedXaiModelId: 'grok' }, { selectedSummaryProvider: 'Xai' }),
    );
    const { settings, raw } = parseSettingsJson(text);
    expect(resolveSummaryProviderKind(settings)).toBe('Xai');
    expect(serializeSettings(raw)).toBe(text);
  });

  it('a patch changes only the named fields', () => {
    const base = applySettingsPatch({}, { summaryLanguage: 'en', uiLanguage: 'es' });
    const next = applySettingsPatch(base, { uiLanguage: 'en' });
    expect(readSettings(next).summaryLanguage).toBe('en');
    expect(readSettings(next).uiLanguage).toBe('en');
  });
});

describe('resolveLiveQuestionsMode', () => {
  const base = { liveQuestions: null, selectedSummaryProvider: null };

  it('defaults to rules+ai with a CLI engine and to rules otherwise', () => {
    expect(resolveLiveQuestionsMode({ ...base, selectedSummaryProvider: 'ClaudeCode' })).toBe(
      'rules+ai',
    );
    expect(resolveLiveQuestionsMode({ ...base, selectedSummaryProvider: 'Codex' })).toBe(
      'rules+ai',
    );
    expect(resolveLiveQuestionsMode({ ...base, selectedSummaryProvider: 'Local' })).toBe('rules');
    expect(resolveLiveQuestionsMode(base)).toBe('rules');
  });

  it('defaults to rules+ai with an API key engine too', () => {
    for (const kind of ['OpenAi', 'Anthropic', 'Gemini', 'Groq', 'OpenAiCompatible']) {
      expect(resolveLiveQuestionsMode({ ...base, selectedSummaryProvider: kind })).toBe('rules+ai');
    }
  });

  it('keeps a saved choice and ignores an unknown one', () => {
    expect(
      resolveLiveQuestionsMode({ liveQuestions: 'off', selectedSummaryProvider: 'Codex' }),
    ).toBe('off');
    expect(resolveLiveQuestionsMode({ ...base, liveQuestions: 'rules+ai' })).toBe('rules+ai');
    expect(
      resolveLiveQuestionsMode({ liveQuestions: 'Rules', selectedSummaryProvider: 'Codex' }),
    ).toBe('rules+ai');
  });

  it('the custom note template is written only once set and round-trips', () => {
    expect(serializeSettings({})).not.toContain('customNoteTemplate');
    const text = serializeSettings(
      applySettingsPatch({}, { customNoteTemplate: 'Use ## Goals\nthen ## Risks' }),
    );
    expect(parseSettingsJson(text).settings.customNoteTemplate).toBe('Use ## Goals\nthen ## Risks');
  });

  it('open at login is off for a file written before it existed, and stays out of it', () => {
    const old = serializeSettings({ uiLanguage: 'es', meetingPopupEnabled: false });
    expect(old).not.toContain('openAtLogin');
    const { raw, settings } = parseSettingsJson(old);
    expect(settings.openAtLogin).toBe(false);
    expect(serializeSettings(raw)).toBe(old);
    expect(serializeSettings(applySettingsPatch(raw, { openAtLogin: false }))).toBe(old);
  });

  it('open at login is written last of the known properties once on, and round-trips', () => {
    const text = serializeSettings(applySettingsPatch({ futureThing: 1 }, { openAtLogin: true }));
    expect(parseSettingsJson(text).settings.openAtLogin).toBe(true);
    expect(text.indexOf('"openAtLogin": true')).toBeGreaterThan(
      text.indexOf('liveCopilotPillAlong'),
    );
    expect(text.indexOf('futureThing')).toBeGreaterThan(text.indexOf('openAtLogin'));
    expect(readSettings({ OpenAtLogin: 'yes' }).openAtLogin).toBe(false);
    expect(readSettings({ openatlogin: true }).openAtLogin).toBe(true);
  });

  it('round-trips through the settings file, written last of the known properties once set', () => {
    const text = serializeSettings(
      applySettingsPatch({ futureThing: 1 }, { liveQuestions: 'off' }),
    );
    expect(parseSettingsJson(text).settings.liveQuestions).toBe('off');
    expect(text.indexOf('"liveQuestions": "off"')).toBeGreaterThan(
      text.indexOf('liveCopilotPillAlong'),
    );
    expect(text.indexOf('futureThing')).toBeGreaterThan(text.indexOf('liveQuestions'));
  });
});

describe('type at cursor settings', () => {
  it('a file written before them loads the defaults and keeps its property set', () => {
    const old = serializeSettings({ uiLanguage: 'es', openAtLogin: true });
    expect(old).not.toContain('cursorTyping');
    const { raw, settings } = parseSettingsJson(old);
    expect(settings.cursorTypingEnabled).toBe(true);
    expect(resolveCursorTypingShortcut(settings)).toBe('CommandOrControl+Alt+Space');
    expect(resolveCursorTypingSource(settings)).toBe('others');
    expect(serializeSettings(raw)).toBe(old);
    expect(
      serializeSettings(
        applySettingsPatch(raw, {
          cursorTypingEnabled: true,
          cursorTypingShortcut: null,
          cursorTypingSource: null,
        }),
      ),
    ).toBe(old);
  });

  it('turning it off is written and round-trips', () => {
    const text = serializeSettings(applySettingsPatch({}, { cursorTypingEnabled: false }));
    expect(text).toContain('"cursorTypingEnabled": false');
    expect(parseSettingsJson(text).settings.cursorTypingEnabled).toBe(false);
    expect(readSettings({ cursorTypingEnabled: 'no' }).cursorTypingEnabled).toBe(true);
  });

  it('a chosen shortcut and source are written once set and round-trip', () => {
    const text = serializeSettings(
      applySettingsPatch(
        { futureThing: 1 },
        { cursorTypingShortcut: 'Ctrl+Shift+T', cursorTypingSource: 'all' },
      ),
    );
    const { settings } = parseSettingsJson(text);
    expect(resolveCursorTypingShortcut(settings)).toBe('Ctrl+Shift+T');
    expect(resolveCursorTypingSource(settings)).toBe('all');
    expect(text.indexOf('futureThing')).toBeGreaterThan(text.indexOf('cursorTypingSource'));
  });

  it('a blank shortcut and an unknown source resolve to the defaults', () => {
    expect(DEFAULT_CURSOR_TYPING_SHORTCUT).toBe('CommandOrControl+Alt+Space');
    for (const shortcut of ['', '   ']) {
      expect(resolveCursorTypingShortcut({ ...defaults, cursorTypingShortcut: shortcut })).toBe(
        DEFAULT_CURSOR_TYPING_SHORTCUT,
      );
    }
    expect(resolveCursorTypingShortcut({ ...defaults, cursorTypingShortcut: ' Alt+F9 ' })).toBe(
      'Alt+F9',
    );
    for (const source of ['All', 'everyone', '']) {
      expect(resolveCursorTypingSource({ ...defaults, cursorTypingSource: source })).toBe('others');
    }
  });
});
