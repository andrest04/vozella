/** Just the path operation the layout needs, so core never imports `node:path`. */
export interface PathJoiner {
  join(...parts: string[]): string;
}

export interface AppPathRoots {
  /** The app data root: settings, models, caches. */
  readonly appData: string;
  /** The Library root: meetings, Inbox and the project directories. */
  readonly library: string;
}

/**
 * The names of the files other modules own are fixed here. The roots themselves are
 * chosen by the data-root guard. The storage of projects lives under `.vozella` in the Library
 * root (see `createStorageLayout`).
 */
export interface AppPaths {
  readonly rootDirectory: string;
  readonly userDataDirectory: string;
  readonly inboxDirectory: string;
  readonly settingsFilePath: string;
  // Owned by other modules; the names must stay.
  readonly modelsDirectory: string;
  readonly transcriptionModelsDirectory: string;
  readonly nemoSpeechDirectory: string;
  readonly summaryModelsDirectory: string;
  readonly chatRecipesFilePath: string;
  /** Saved chat prompts of this app (Phase 5). The earlier `chat-recipes.json` is left alone. */
  readonly chatPromptsFilePath: string;
  /** Nothing reads or deletes this file (xAI was removed). */
  readonly xaiCredentialsFilePath: string;
  readonly customNoteTemplateFilePath: string;
}

export function createAppPaths(roots: AppPathRoots, path: PathJoiner): AppPaths {
  const root = roots.appData;
  const library = roots.library;
  return {
    rootDirectory: root,
    userDataDirectory: library,
    inboxDirectory: path.join(library, 'Inbox'),
    settingsFilePath: path.join(root, 'settings.json'),
    modelsDirectory: path.join(root, 'Models'),
    transcriptionModelsDirectory: path.join(root, 'TranscriptionModels'),
    nemoSpeechDirectory: path.join(root, 'NemoSpeech'),
    summaryModelsDirectory: path.join(root, 'SummaryModels'),
    chatRecipesFilePath: path.join(root, 'chat-recipes.json'),
    chatPromptsFilePath: path.join(root, 'chat-prompts.json'),
    xaiCredentialsFilePath: path.join(root, 'xai-credentials.bin'),
    customNoteTemplateFilePath: path.join(root, 'custom-note-template.json'),
  };
}
