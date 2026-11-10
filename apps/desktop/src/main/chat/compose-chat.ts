import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  ATTACHMENT_EXTENSIONS,
  ChatService,
  type Logger,
  type SummaryProviderResolver,
  type TranslateFn,
} from '@vozella/core';
import {
  ChatAttachmentStore,
  createThreadedDocumentExtractor,
  JsonChatPromptStore,
  LibraryChatReader,
  SystemClock,
  writeFileAtomic,
  type LibraryRuntime,
} from '@vozella/platform';
import { registerChatHandlers } from '../ipc/chat-handlers';
import { registerChatPromptHandlers } from '../ipc/chat-prompts-handlers';
import type { Broadcast } from '../ipc/library-handlers';
import type { IpcServerDeps } from '../ipc/ipc-server';
import type { LiveChatContext } from '../recording/live-ask-handlers';
import type { WindowDialogs } from '../window-dialogs';
import { ChatController, chatProviderSource, type ChatControllerDeps } from './chat-controller';
import { recordingProviderSource } from './chat-prompt-log';
import { ChatPromptsController } from './chat-prompts-controller';

export interface ComposeChatDeps {
  readonly library: Pick<LibraryRuntime, 'meetings' | 'folders' | 'paths'>;
  readonly resolver: SummaryProviderResolver;
  /** Already scoped to the chat (`logger.child('chat')`). */
  readonly logger: Logger;
  readonly translate: TranslateFn;
  readonly uiLanguage: () => string;
  /** The live ask is built with the recording, after the chat; until then Live has no digest. */
  readonly liveContext: () => LiveChatContext;
  readonly broadcast: Broadcast;
  readonly server: IpcServerDeps;
  readonly dialogs: WindowDialogs;
  readonly tempDirectory: () => string;
  readonly documentsDirectory: () => string;
  /** The folder of the bundled workers (`extract.js`). */
  readonly workersDirectory: string;
  readonly writeClipboard: ChatControllerDeps['writeClipboard'];
  /** Opens a link in the browser; the fake native build substitutes its double. */
  readonly openExternal: ChatControllerDeps['openExternal'];
  /** E2E double: when set, each prompt and its engine are appended to this file. */
  readonly promptLogFile?: string;
}

export interface ComposedChat {
  readonly service: ChatService;
  readonly controller: ChatController;
  readonly prompts: ChatPromptsController;
}

/** The chat and its saved prompts, with their IPC handlers. */
export function composeChat(deps: ComposeChatDeps): ComposedChat {
  const { library, logger, translate, broadcast } = deps;
  // Chat: one in-memory conversation; the engine is whichever one the summaries resolver picks.
  const chatReader = new LibraryChatReader({
    meetings: library.meetings,
    folders: library.folders,
  });
  // Attached files: paths stay here; the page holds ids. Image copies for one send go to temp.
  const chatAttachments = new ChatAttachmentStore({
    translate,
    logger,
    tempRoot: deps.tempDirectory(),
    // PDF, Word and PowerPoint are parsed in a worker thread, never on this one.
    extractor: createThreadedDocumentExtractor(
      () => new Worker(path.join(deps.workersDirectory, 'extract.js')),
    ),
  });
  const chatPromptLog = deps.promptLogFile;
  const chatProviders = chatPromptLog
    ? // E2E double: each prompt and the engine that answers it go to a file the spec reads.
      recordingProviderSource(chatProviderSource(deps.resolver), (prompt, engine) => {
        fs.appendFileSync(
          chatPromptLog,
          `${prompt}\n<<<ENGINE ${engine ?? 'local'}>>>\n<<<END>>>\n`,
        );
      })
    : chatProviderSource(deps.resolver);
  const chatService = new ChatService({
    meetings: chatReader,
    providers: chatProviders,
    attachments: chatAttachments,
    clock: new SystemClock(),
    translate,
    newId: () => randomUUID(),
    logger,
    uiLanguage: deps.uiLanguage,
  });
  const chat = new ChatController({
    service: chatService,
    findMeetingId: (id) => chatReader.findMeetingId(id),
    writeClipboard: deps.writeClipboard,
    openExternal: deps.openExternal,
    broadcast,
    translate,
    logger,
    liveContext: () => deps.liveContext(),
    attachments: chatAttachments,
    pickAttachments: async () => {
      const result = await deps.dialogs.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: translate('Ui_ChatAttachFilter'), extensions: [...ATTACHMENT_EXTENSIONS] },
        ],
      });
      return result.canceled ? [] : result.filePaths;
    },
  });
  registerChatHandlers({ server: deps.server, controller: chat });

  // Saved prompts (Phase 5): chat-prompts.json in app data, export and import through dialogs.
  const promptsFilter = { name: translate('Ui_ChatPromptsFileFilter'), extensions: ['json'] };
  const chatPrompts = new ChatPromptsController({
    store: new JsonChatPromptStore({
      filePath: library.paths.chatPromptsFilePath,
      newId: () => randomUUID(),
      logger,
    }),
    broadcast,
    logger,
    pickExportPath: async () => {
      const result = await deps.dialogs.showSaveDialog({
        defaultPath: path.join(
          deps.documentsDirectory(),
          `${translate('Ui_ChatPromptsFileName')}.vozella-prompts.json`,
        ),
        filters: [promptsFilter],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    pickImportPath: async () => {
      const result = await deps.dialogs.showOpenDialog({
        properties: ['openFile'],
        filters: [promptsFilter],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    readText: async (file) => {
      // A prompts file is small; anything over 2 MB is refused before it is read.
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error('not a prompts file');
      return fs.promises.readFile(file, 'utf8');
    },
    writeText: (file, text) => writeFileAtomic(file, text),
  });
  registerChatPromptHandlers({ server: deps.server, controller: chatPrompts });

  return { service: chatService, controller: chat, prompts: chatPrompts };
}
