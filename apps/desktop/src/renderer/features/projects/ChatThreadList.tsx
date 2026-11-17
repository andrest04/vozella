import { MessageSquarePlus } from 'lucide-react';
import { useMemo } from 'react';
import { requestChat } from '../../app/chat-requests';
import { ChatThreadRows } from '../../app/ChatThreadRows';
import { useChatThreads } from '../../app/chat-threads';
import { useI18n } from '../../i18n/I18nProvider';
import { Button, EmptyState, Notice, Skeleton } from '../../ui';
import { useMeetingListStore } from '../meeting-list/meeting-list-store';

export interface ChatThreadListProps {
  /** The project whose chats these are; null for the chats that belong to no project. */
  readonly owner: string | null;
}

/** The saved chats of an owner, newest first. Opening one hands it to the chat panel. */
export function ChatThreadList({ owner }: ChatThreadListProps) {
  const { t } = useI18n();
  const model = useChatThreads(owner);
  const meetings = useMeetingListStore((state) => state.meetings);
  const loaded = useMeetingListStore((state) => !state.isLoading);
  const titles = useMemo(
    () => (loaded ? new Map(meetings.map((meeting) => [meeting.id, meeting.title])) : null),
    [loaded, meetings],
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          size="sm"
          icon={MessageSquarePlus}
          onClick={() => {
            requestChat({ kind: 'new-chat', projectId: owner });
          }}
        >
          {t('Ui_ChatThreadsNew')}
        </Button>
      </div>
      {model.status === 'loading' ? (
        <div role="status" aria-label={t('Ui_Loading')} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : model.status === 'failed' ? (
        <Notice tone="warning">
          <div className="flex flex-col items-start gap-2">
            <p>{t('Ui_ChatHistoryFailed')}</p>
            <Button
              size="sm"
              onClick={() => {
                void model.reload();
              }}
            >
              {t('Ui_Retry')}
            </Button>
          </div>
        </Notice>
      ) : model.threads.length === 0 ? (
        <EmptyState
          message={owner === null ? t('Ui_ChatThreadsEmptyNone') : t('Ui_ChatThreadsEmpty')}
        />
      ) : (
        <ChatThreadRows
          threads={model.threads}
          meetingTitles={titles}
          onOpen={(thread) => {
            requestChat({ kind: 'open-thread', projectId: owner, threadId: thread.id });
          }}
          onRename={model.rename}
          onRemove={model.remove}
        />
      )}
    </div>
  );
}
