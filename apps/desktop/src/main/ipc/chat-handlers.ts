import {
  chatAttachDrop,
  chatAttachList,
  chatAttachPick,
  chatAttachRemove,
  chatCancel,
  chatCopyText,
  chatGetEngineChoices,
  chatMeetingExists,
  chatNewChat,
  chatOpenExternal,
  chatSend,
  chatSetScope,
  chatState,
  chatThreadsDelete,
  chatThreadsList,
  chatThreadsOpen,
  chatThreadsRename,
} from '@vozella/contracts';
import type { ChatController } from '../chat/chat-controller';
import { registerRequest, type IpcServerDeps } from './ipc-server';

export interface ChatHandlerDeps {
  readonly server: IpcServerDeps;
  readonly controller: ChatController;
}

/** Wires the chat channels. One line per channel; the rules live in core. */
export function registerChatHandlers({ server, controller }: ChatHandlerDeps): void {
  registerRequest(server, chatSend, (input) => controller.send(input));
  registerRequest(server, chatGetEngineChoices, () => controller.engineChoices());
  registerRequest(server, chatCancel, () => ({ cancelled: controller.cancel() }));
  registerRequest(server, chatNewChat, () => ({ started: controller.newChat() }));
  registerRequest(server, chatState, () => controller.state());
  registerRequest(server, chatSetScope, ({ scope }) => controller.setScope(scope));
  registerRequest(server, chatMeetingExists, ({ meetingId }) =>
    controller.meetingExists(meetingId),
  );
  registerRequest(server, chatCopyText, ({ text }) => controller.copyText(text));
  registerRequest(server, chatOpenExternal, ({ url }) => controller.openExternal(url));
  registerRequest(server, chatAttachPick, () => controller.attachPick());
  registerRequest(server, chatAttachDrop, ({ paths }) => controller.attachDrop(paths));
  registerRequest(server, chatAttachRemove, ({ id }) => controller.attachRemove(id));
  registerRequest(server, chatAttachList, () => controller.attachList());
  // Saved conversations: every id is a guid by the time it gets here (the schema checked it).
  registerRequest(server, chatThreadsList, ({ projectId }) => controller.threadsList(projectId));
  registerRequest(server, chatThreadsOpen, ({ projectId, id }) =>
    controller.threadsOpen(projectId, id),
  );
  registerRequest(server, chatThreadsRename, async ({ projectId, id, title }) => ({
    ok: await controller.threadsRename(projectId, id, title),
  }));
  registerRequest(server, chatThreadsDelete, async ({ projectId, id }) => ({
    ok: await controller.threadsDelete(projectId, id),
  }));
}
