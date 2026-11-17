import type { ChatThreadSummaryDto } from '@vozella/contracts';
import { Ellipsis, MessageSquarePlus, Pencil, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { requestChat } from '../../app/chat-requests';
import { threadBadge, useChatThreads, type ThreadBadge } from '../../app/chat-threads';
import { useI18n } from '../../i18n/I18nProvider';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Menu, Skeleton } from '../../ui';
import { useMeetingListStore } from '../meeting-list/meeting-list-store';
import { formatActivity } from './project-list-model';
import { InlineText } from './InlineText';

export interface ChatThreadListProps {
  /** The project whose chats these are; null for the chats that belong to no project. */
  readonly owner: string | null;
}

/** The saved chats of an owner, newest first. Opening one hands it to the chat panel. */
export function ChatThreadList({ owner }: ChatThreadListProps) {
  const { t, locale } = useI18n();
  const model = useChatThreads(owner);
  const meetings = useMeetingListStore((state) => state.meetings);
  const loaded = useMeetingListStore((state) => !state.isLoading);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatThreadSummaryDto | null>(null);
  const titles = useMemo(
    () => (loaded ? new Map(meetings.map((meeting) => [meeting.id, meeting.title])) : null),
    [loaded, meetings],
  );
  const now = Date.now();

  const badgeText = (badge: ThreadBadge): string => {
    switch (badge.kind) {
      case 'project':
        return t('Ui_ChatBadgeProject');
      case 'all':
        return t('Ui_ChatBadgeAll');
      case 'live':
        return t('Ui_ChatBadgeLive');
      case 'meeting':
        return badge.title ?? t('Ui_ChatBadgeMeeting');
      case 'meeting-deleted':
        return t('Ui_ChatBadgeMeetingDeleted');
    }
  };

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
      ) : model.threads.length === 0 ? (
        <EmptyState
          message={owner === null ? t('Ui_ChatThreadsEmptyNone') : t('Ui_ChatThreadsEmpty')}
        />
      ) : (
        <ul className="flex flex-col">
          {model.threads.map((thread) => {
            const badge = threadBadge(thread, titles);
            return (
              <li
                key={thread.id}
                className="flex items-center gap-2 border-b border-hairline py-2 last:border-b-0"
              >
                {renaming === thread.id ? (
                  <InlineText
                    value={thread.title}
                    editing
                    onEditingChange={(editing) => {
                      if (!editing) setRenaming(null);
                    }}
                    label={t('Ui_ChatThreadRename')}
                    maxLength={200}
                    onSave={async (next) =>
                      next.trim() === ''
                        ? { ok: false, error: t('Ui_ChatThreadTitleRequired') }
                        : (await model.rename(thread.id, next.trim()))
                          ? { ok: true }
                          : { ok: false, error: t('Ui_ChatThreadFailed') }
                    }
                    display={null}
                    className="flex-1"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      requestChat({ kind: 'open-thread', projectId: owner, threadId: thread.id });
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control px-2 py-1 text-start transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed"
                  >
                    <span className="max-w-full truncate text-ui-lg font-medium text-ink">
                      {thread.title}
                    </span>
                    <span className="flex max-w-full items-center gap-2 text-caption text-ink-muted">
                      <span className="tabular font-mono">
                        {formatActivity(thread.updatedAt, locale, now)}
                      </span>
                      <Badge tone="outline" className="max-w-56 truncate">
                        {badgeText(badge)}
                      </Badge>
                    </span>
                  </button>
                )}
                <Menu
                  align="end"
                  trigger={
                    <IconButton
                      label={t('Ui_ChatThreadActions', thread.title)}
                      icon={Ellipsis}
                      size="sm"
                    />
                  }
                  entries={[
                    {
                      id: 'rename',
                      label: t('Ui_ChatThreadRename'),
                      icon: Pencil,
                      onSelect: () => {
                        setRenaming(thread.id);
                      },
                    },
                    {
                      id: 'delete',
                      label: t('Ui_ChatThreadDelete'),
                      icon: Trash,
                      onSelect: () => {
                        setDeleting(thread);
                      },
                    },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('Ui_ChatThreadDeleteTitle')}
        description={t('Ui_ChatThreadDeleteContent', deleting?.title ?? '')}
        cancelLabel={t('Ui_Cancel')}
        closeLabel={t('Ui_Close')}
        primaryLabel={t('Ui_ChatThreadDelete')}
        onConfirm={() => {
          if (deleting) void model.remove(deleting.id);
        }}
      />
    </div>
  );
}
