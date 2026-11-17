import type { ReactNode } from 'react';
import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Tabs } from '../../ui';
import { MeetingList } from '../meeting-list/MeetingList';
import type { MeetingScope } from '../meeting-list/scope';
import { ChatThreadList } from './ChatThreadList';

export interface ProjectTabsProps {
  readonly scope: MeetingScope;
  /** The owner of the chats: the project id, or null for no project. */
  readonly owner: string | null;
  /** Beside the empty message of the meetings, where there is a next step to offer. */
  readonly meetingsEmptyAction?: ReactNode;
}

/** Meetings and Chats of a project, or of no project. Arrows move between the tabs. */
export function ProjectTabs({ scope, owner, meetingsEmptyAction }: ProjectTabsProps) {
  const t = useT();
  const [tab, setTab] = useState('meetings');
  return (
    <Tabs
      label={t('Ui_ProjectTabs')}
      value={tab}
      onValueChange={setTab}
      tabs={[
        {
          value: 'meetings',
          label: t('Ui_ProjectTabMeetings'),
          content: (
            <div className="flex h-[min(70vh,720px)] min-h-[360px] flex-col rounded-overlay border border-hairline">
              <MeetingList
                scope={scope}
                title={null}
                {...(meetingsEmptyAction === undefined
                  ? {}
                  : { projectEmptyAction: meetingsEmptyAction })}
              />
            </div>
          ),
        },
        {
          value: 'chats',
          label: t('Ui_ProjectTabChats'),
          content: <ChatThreadList owner={owner} />,
        },
      ]}
    />
  );
}
