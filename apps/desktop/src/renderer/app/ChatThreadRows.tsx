import type { ChatThreadSummaryDto } from '@vozella/contracts';
import { Ellipsis, Pencil, Trash } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { Badge, ConfirmDialog, IconButton, InlineText, Menu, cn } from '../ui';
import { threadBadge, type ThreadBadge } from './chat-threads';

export interface ChatThreadRowsProps {
  readonly threads: readonly ChatThreadSummaryDto[];
  /** Meeting titles by id, or null while the meetings load (nothing is called deleted yet). */
  readonly meetingTitles: ReadonlyMap<string, string> | null;
  readonly onOpen: (thread: ChatThreadSummaryDto) => void;
  readonly onRename: (id: string, title: string) => Promise<boolean>;
  readonly onRemove: (id: string) => Promise<boolean>;
  /** The rows of a small popover: the same words, a tighter row. */
  readonly compact?: boolean;
}

/** "14 Nov": the day of the last activity, in the language of the app. */
function shortDay(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(ms))
    .replace(/\./g, '');
}

/**
 * Saved chats as rows: a button that opens the chat, its date and scope badge, and a menu to
 * rename it in place or delete it after a confirmation. The Chats tab and the panel's History
 * share it, so a chat reads the same wherever it is listed.
 */
export function ChatThreadRows({
  threads,
  meetingTitles,
  onOpen,
  onRename,
  onRemove,
  compact = false,
}: ChatThreadRowsProps) {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatThreadSummaryDto | null>(null);
  const [failed, setFailed] = useState(false);

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
    <>
      {failed ? (
        <p role="alert" className="px-1 py-2 text-ui text-ink">
          {t('Ui_ChatThreadFailed')}
        </p>
      ) : null}
      <ul className="flex flex-col">
        {threads.map((thread) => (
          <li
            key={thread.id}
            className={cn(
              'flex items-center gap-2 border-b border-hairline last:border-b-0',
              compact ? 'py-1' : 'py-2',
            )}
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
                    : (await onRename(thread.id, next.trim()))
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
                  onOpen(thread);
                }}
                className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control px-2 py-1 text-start transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed"
              >
                <span className="max-w-full truncate text-ui-lg font-medium text-ink">
                  {thread.title}
                </span>
                <span className="flex max-w-full items-center gap-2 text-caption text-ink-muted">
                  <span className="tabular font-mono">{shortDay(thread.updatedAt, locale)}</span>
                  <Badge tone="outline" className="max-w-40 truncate">
                    {badgeText(threadBadge(thread, meetingTitles))}
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
        ))}
      </ul>
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
          if (!deleting) return;
          setFailed(false);
          void onRemove(deleting.id).then((ok) => {
            if (!ok) setFailed(true);
          });
        }}
      />
    </>
  );
}
