import type { ProjectDto } from '@vozella/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Ellipsis, FileText, Mic, Pencil, Pin, Trash } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import {
  Button,
  ConfirmDialog,
  Disclosure,
  Icon,
  IconButton,
  InlineText,
  Menu,
  Notice,
  Skeleton,
  useMediaQuery,
  type InlineSave,
  type MenuEntry,
} from '../../ui';
import { refreshProjectDirectory, useProjectDirectory } from '../meeting-list/project-directory';
import { projectScope } from '../meeting-list/scope';
import { InstructionsPanel } from './InstructionsPanel';
import { ProjectFilesPanel } from './ProjectFilesPanel';
import { ProjectTabs } from './ProjectTabs';
import { useProject } from './use-project';
import { useProjectFiles } from './use-project-files';
import { failureKey } from './use-projects';

/** Two columns from this width; below it the right panel stacks under the header. */
export const SIDE_PANEL_QUERY = '(min-width: 960px)';

type Editing = 'name' | 'description' | null;

function BackLink() {
  const { t } = useI18n();
  return (
    <Link
      to="/projects"
      className="inline-flex w-fit items-center gap-1 rounded-control text-ui text-ink-muted transition-colors duration-150 ease-out-quick hover:text-ink"
    >
      <Icon icon={ChevronLeft} size={14} />
      {t('Ui_ProjectsTitle')}
    </Link>
  );
}

export function ProjectNotFound() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      <div className="flex flex-col items-start gap-2">
        <h1 className="text-heading font-semibold">{t('Ui_ProjectNotFound')}</h1>
        <p className="text-read text-ink-muted">{t('Ui_ProjectNotFoundHint')}</p>
        <Link
          to="/projects"
          className="inline-flex h-8 items-center rounded-control border border-border-control px-3 text-ui-lg font-medium transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed"
        >
          {t('Ui_ProjectNotFoundBack')}
        </Link>
      </div>
    </div>
  );
}

/** What the page says above its content: how a delete went, or that a header action failed. */
type PageNotice =
  | { readonly kind: 'partial'; readonly moved: number; readonly remaining: number }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed'; readonly text: string };

/** One project: header with inline editing, its meetings and chats, and the panel at the side. */
export function ProjectPage({ projectId }: { readonly projectId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const state = useProject(projectId);
  const item = useProjectDirectory((s) => s.projects.find((p) => p.id === projectId));
  const storageReady = useProjectDirectory((s) => s.storage.status === 'ready');
  const sideBySide = useMediaQuery(SIDE_PANEL_QUERY);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const files = useProjectFiles(projectId, state.reload);
  // Held here, not in the panel: the panel is laid out differently on each side of the breakpoint
  // and would otherwise start over, losing what was typed.
  const [instructionsEdit, setInstructionsEdit] = useState<{
    readonly projectId: string;
    readonly text: string;
  } | null>(null);
  const instructionsDraft =
    instructionsEdit?.projectId === projectId ? instructionsEdit.text : null;

  if (state.phase === 'not-found') return <ProjectNotFound />;
  const project = state.project;
  if (state.phase === 'unavailable') {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Notice tone="warning">{t('Ui_ProjectsUnavailableNow')}</Notice>
      </div>
    );
  }
  if (project === null) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div role="status" aria-label={t('Ui_Loading')} className="flex flex-col gap-3">
          <Skeleton className="h-7 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
      </div>
    );
  }

  const failure = (reason: Parameters<typeof failureKey>[0], message?: string): string => {
    const key: StringKey = failureKey(reason);
    return t(key, message ?? reason);
  };
  const update = async (patch: {
    name?: string;
    description?: string;
    pinned?: boolean;
  }): Promise<InlineSave> => {
    try {
      const result = await window.vozella.invoke('projects.update', { id: project.id, ...patch });
      if (!result.ok) return { ok: false, error: failure(result.reason, result.message) };
      await Promise.all([state.reload(), refreshProjectDirectory()]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: failure('io-failed', error instanceof Error ? error.message : String(error)),
      };
    }
  };
  const saveInstructions = async (text: string): Promise<string | null> => {
    try {
      const result = await window.vozella.invoke('projects.setInstructions', {
        id: project.id,
        instructions: text,
      });
      if (!result.ok) {
        return result.reason === 'too-long'
          ? t('Ui_ProjectInstructionsTooLong')
          : result.reason.startsWith('storage-')
            ? t('Ui_ProjectsUnavailableNow')
            : t('Ui_ProjectInstructionsFailed', result.message ?? result.reason);
      }
      await state.reload();
      return null;
    } catch (error) {
      return t(
        'Ui_ProjectInstructionsFailed',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const runDelete = async (): Promise<void> => {
    setNotice(null);
    try {
      const result = await window.vozella.invoke('projects.delete', { id: project.id });
      if (result.ok) {
        await refreshProjectDirectory();
        void navigate({ to: '/projects' });
      } else if (result.reason === 'partial') {
        setNotice({ kind: 'partial', moved: result.moved, remaining: result.remaining });
      } else if (result.reason === 'busy') {
        setNotice({ kind: 'busy' });
      } else {
        setNotice({ kind: 'failed', text: failure(result.reason, result.message) });
      }
    } catch (error) {
      setNotice({
        kind: 'failed',
        text: failure('io-failed', error instanceof Error ? error.message : String(error)),
      });
    }
  };

  const meetingCount = item?.meetingCount ?? 0;
  const deleteContent =
    meetingCount === 0
      ? t('Ui_ProjectDeleteContentNone')
      : meetingCount === 1
        ? t('Ui_ProjectDeleteContentOne')
        : t('Ui_ProjectDeleteContentMany', String(meetingCount));

  const entries: MenuEntry[] = [
    {
      id: 'rename',
      label: t('Ui_ProjectRename'),
      icon: Pencil,
      disabled: !storageReady,
      onSelect: () => {
        setEditing('name');
      },
    },
    {
      id: 'description',
      label: t('Ui_ProjectEditDescription'),
      icon: FileText,
      disabled: !storageReady,
      onSelect: () => {
        setEditing('description');
      },
    },
    {
      id: 'pin',
      label: project.pinned ? t('Ui_ProjectUnpin') : t('Ui_ProjectPin'),
      icon: Pin,
      disabled: !storageReady,
      onSelect: () => {
        void update({ pinned: !project.pinned }).then((saved) => {
          if (!saved.ok) setNotice({ kind: 'failed', text: saved.error });
        });
      },
    },
    {
      id: 'delete',
      label: t('Ui_ProjectDelete'),
      icon: Trash,
      disabled: !storageReady,
      onSelect: () => {
        setConfirmDelete(true);
      },
    },
  ];

  const startMeeting = (
    <Button
      variant="primary"
      icon={Mic}
      onClick={() => {
        void navigate({ to: '/record', search: { project: project.id, start: 1 } });
      }}
    >
      {t('Ui_ProjectStartMeeting')}
    </Button>
  );

  const instructions = (
    <InstructionsPanel
      instructions={project.instructions}
      onSave={saveInstructions}
      disabled={!storageReady}
      draft={instructionsDraft}
      onDraftChange={(text) => {
        setInstructionsEdit(text === null ? null : { projectId, text });
      }}
    />
  );
  const filesPanel = (
    <ProjectFilesPanel
      files={state.files}
      pending={files.pending}
      problems={files.problems}
      disabled={!storageReady}
      onAdd={() => {
        void files.pick();
      }}
      onRemove={(file) => {
        void files.remove(file.id, file.name);
      }}
      onDismissProblem={files.dismiss}
    />
  );

  const side: ReactNode = sideBySide ? (
    <aside aria-label={t('Ui_ProjectSidePanel')} className="flex w-80 shrink-0 flex-col gap-6">
      <section aria-labelledby="project-instructions" className="flex flex-col gap-2">
        <h2 id="project-instructions" className="text-ui-lg font-semibold">
          {t('Ui_ProjectInstructions')}
        </h2>
        {instructions}
      </section>
      <section aria-labelledby="project-files" className="flex flex-col gap-2">
        <h2 id="project-files" className="text-ui-lg font-semibold">
          {t('Ui_ProjectFiles')}
        </h2>
        {filesPanel}
      </section>
    </aside>
  ) : (
    <div className="flex flex-col">
      <Disclosure
        title={t('Ui_ProjectInstructions')}
        defaultOpen={project.instructions.trim() === ''}
      >
        {instructions}
      </Disclosure>
      <Disclosure title={t('Ui_ProjectFiles')}>{filesPanel}</Disclosure>
    </div>
  );

  return (
    <div className="flex flex-col gap-5" data-layout={sideBySide ? 'side' : 'stacked'}>
      <BackLink />
      <ProjectHeader
        project={project}
        editing={editing}
        onEditingChange={setEditing}
        onSave={update}
        actions={
          <>
            {startMeeting}
            <Menu
              align="end"
              trigger={
                <IconButton label={t('Ui_ProjectActions')} icon={Ellipsis} variant="secondary" />
              }
              entries={entries}
            />
          </>
        }
      />
      {notice ? (
        <Notice
          tone="warning"
          onDismiss={() => {
            setNotice(null);
          }}
          dismissLabel={t('Ui_Close')}
        >
          <div className="flex flex-col items-start gap-2">
            <p>
              {notice.kind === 'partial'
                ? t(
                    'Ui_ProjectDeletePartial',
                    String(notice.moved),
                    String(notice.moved + notice.remaining),
                  )
                : notice.kind === 'busy'
                  ? t('Ui_ProjectDeleteBusy')
                  : notice.text}
            </p>
            {notice.kind === 'partial' ? (
              <Button
                size="sm"
                onClick={() => {
                  void runDelete();
                }}
              >
                {t('Ui_Retry')}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}
      <div className={sideBySide ? 'flex items-start gap-8' : 'flex flex-col gap-5'}>
        {sideBySide ? null : side}
        <div className="min-w-0 flex-1">
          <ProjectTabs
            scope={projectScope(project.id)}
            owner={project.id}
            meetingsEmptyAction={startMeeting}
          />
        </div>
        {sideBySide ? side : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('Ui_ProjectDeleteTitle')}
        description={deleteContent}
        cancelLabel={t('Ui_Cancel')}
        closeLabel={t('Ui_Close')}
        primaryLabel={t('Ui_ProjectDeleteConfirm')}
        onConfirm={() => {
          void runDelete();
        }}
      />
    </div>
  );
}

function ProjectHeader({
  project,
  editing,
  onEditingChange,
  onSave,
  actions,
}: {
  readonly project: ProjectDto;
  readonly editing: Editing;
  readonly onEditingChange: (editing: Editing) => void;
  readonly onSave: (patch: { name?: string; description?: string }) => Promise<InlineSave>;
  readonly actions: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <InlineText
          value={project.name}
          editing={editing === 'name'}
          onEditingChange={(next) => {
            onEditingChange(next ? 'name' : null);
          }}
          label={t('Ui_ProjectName')}
          maxLength={120}
          onSave={(name) => onSave({ name })}
          display={
            <h1 className="text-heading font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
              {project.name}
            </h1>
          }
        />
        <InlineText
          value={project.description}
          editing={editing === 'description'}
          onEditingChange={(next) => {
            onEditingChange(next ? 'description' : null);
          }}
          label={t('Ui_ProjectDescription')}
          maxLength={500}
          multiline
          onSave={(description) => onSave({ description })}
          display={
            project.description === '' ? (
              <div>
                <Button
                  size="sm"
                  variant="quiet"
                  className="-ms-2.5"
                  onClick={() => {
                    onEditingChange('description');
                  }}
                >
                  {t('Ui_ProjectAddDescription')}
                </Button>
              </div>
            ) : (
              <p className="max-w-[65ch] text-read text-ink-muted [overflow-wrap:anywhere]">
                {project.description}
              </p>
            )
          }
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}
