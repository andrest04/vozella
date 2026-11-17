import { describe, expect, it } from 'vitest';
import { createAppPaths } from './app-paths';

// Core has no Node dependency; a backslash joiner is enough to check the layout.
const win = { join: (...parts: string[]) => parts.join(String.fromCharCode(92)) };
const paths = createAppPaths({ appData: 'C:\\Local\\App', library: 'C:\\Docs\\Library' }, win);

describe('createAppPaths', () => {
  it('puts Inbox under the Library root', () => {
    expect(paths.userDataDirectory).toBe('C:\\Docs\\Library');
    expect(paths.inboxDirectory).toBe('C:\\Docs\\Library\\Inbox');
  });

  it('puts settings and credentials under the app data root', () => {
    expect(paths.rootDirectory).toBe('C:\\Local\\App');
    expect(paths.settingsFilePath).toBe('C:\\Local\\App\\settings.json');
    expect(paths.xaiCredentialsFilePath).toBe('C:\\Local\\App\\xai-credentials.bin');
  });

  it('keeps the exact names other modules rely on', () => {
    expect(paths.modelsDirectory).toBe('C:\\Local\\App\\Models');
    expect(paths.transcriptionModelsDirectory).toBe('C:\\Local\\App\\TranscriptionModels');
    expect(paths.nemoSpeechDirectory).toBe('C:\\Local\\App\\NemoSpeech');
    expect(paths.summaryModelsDirectory).toBe('C:\\Local\\App\\SummaryModels');
    expect(paths.chatRecipesFilePath).toBe('C:\\Local\\App\\chat-recipes.json');
    expect(paths.customNoteTemplateFilePath).toBe('C:\\Local\\App\\custom-note-template.json');
  });
});
