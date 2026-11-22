import { History, MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { ChatThreadRows } from '../../app/ChatThreadRows';
import { useChatThreads } from '../../app/chat-threads';
import { useT } from '../../i18n/I18nProvider';
import { Button, IconButton, Popover, Skeleton } from '../../ui';
import { useMeetingTitles } from './use-meeting-titles';

export interface ChatHistoryProps {
  /** Whose chats are listed: a project, or null for no project. */
  readonly owner: string | null;
  readonly onOpen: (threadId: string) => void;
  readonly onNewChat: () => void;
  readonly canStartNewChat: boolean;
  readonly disabled: boolean;
}

function HistoryList({
  owner,
  onOpen,
  onNewChat,
  canStartNewChat,
  close,
}: Omit<ChatHistoryProps, 'disabled'> & { readonly close: () => void }) {
  const t = useT();
  const model = useChatThreads(owner);
  const titles = useMeetingTitles();
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        icon={MessageSquarePlus}
        disabled={!canStartNewChat}
        onClick={() => {
          close();
          onNewChat();
        }}
      >
        {t('Ui_ChatThreadsNew')}
      </Button>
      {model.status === 'loading' ? (
        <div role="status" aria-label={t('Ui_Loading')} className="flex flex-col gap-2 py-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : model.status === 'failed' ? (
        <p role="status" className="px-1 py-2 text-ui text-ink">
          {t('Ui_ChatHistoryFailed')}
        </p>
      ) : model.threads.length === 0 ? (
        <p className="px-1 py-2 text-ui text-ink-muted">
          {owner === null ? t('Ui_ChatThreadsEmptyNone') : t('Ui_ChatThreadsEmpty')}
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <ChatThreadRows
            compact
            threads={model.threads}
            meetingTitles={titles}
            onOpen={(thread) => {
              close();
              onOpen(thread.id);
            }}
            onRename={model.rename}
            onRemove={model.remove}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The panel's History control: a popover with the saved chats of the current owner, New chat, and
 * for each chat open, rename and delete. The list is read when the popover opens.
 */
export function ChatHistory(props: ChatHistoryProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('Ui_ChatHistory')}
      align="end"
      className="w-80 p-2"
      trigger={
        <IconButton
          id="BtnMeetingChatHistory"
          data-testid="BtnMeetingChatHistory"
          label={t('Ui_ChatHistory')}
          icon={History}
          disabled={props.disabled}
          className="text-ink-muted hover:text-ink"
        />
      }
    >
      {open ? (
        <HistoryList
          owner={props.owner}
          onOpen={props.onOpen}
          onNewChat={props.onNewChat}
          canStartNewChat={props.canStartNewChat}
          close={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </Popover>
  );
}
