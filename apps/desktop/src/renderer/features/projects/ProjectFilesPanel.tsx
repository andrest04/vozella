import type { ProjectFileDto, ProjectFileFailureDto } from '@vozella/contracts';
import { CircleAlert, FileText, Plus, X } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey, Translate } from '../../i18n/translate';
import { Button, Icon, IconButton, Skeleton } from '../../ui';
import type { FileProblem } from './use-project-files';

const FAILURE_KEYS: Readonly<Record<ProjectFileFailureDto | 'remove-failed', StringKey>> = {
  'remove-failed': 'Ui_ProjectFileRemoveFailed',
  encrypted: 'Ui_ProjectFileEncrypted',
  duplicate: 'Ui_ProjectFileDuplicate',
  'too-large': 'Ui_ProjectFileTooLarge',
  'project-full': 'Ui_ProjectFileFull',
  'no-text': 'Ui_ProjectFileNoText',
  unsupported: 'Ui_ProjectFileUnsupported',
  unreadable: 'Ui_ProjectFileUnreadable',
  'not-found': 'Ui_ProjectFileNotFound',
  'not-a-project': 'Ui_ProjectFileNoProject',
  'storage-migrating': 'Ui_ProjectsUnavailableNow',
  'storage-error': 'Ui_ProjectsUnavailableNow',
  'storage-newer': 'Ui_ProjectsUnavailableNow',
};

const KIND_KEYS: Readonly<Record<ProjectFileDto['kind'], StringKey>> = {
  pdf: 'Ui_ProjectFileKindPdf',
  docx: 'Ui_ProjectFileKindDocx',
  pptx: 'Ui_ProjectFileKindPptx',
  text: 'Ui_ProjectFileKindText',
};

/** "3 KB", "1.2 MB": binary units, one decimal from megabytes up. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PDF · 12 pages", "Text · 3 KB". Slides count for a presentation. */
export function describeFile(file: ProjectFileDto, t: Translate): string {
  const parts: string[] = [t(KIND_KEYS[file.kind])];
  if (file.pages !== null) {
    const slides = file.kind === 'pptx';
    parts.push(
      file.pages === 1
        ? t(slides ? 'Ui_ProjectFileSlideOne' : 'Ui_ProjectFilePageOne')
        : t(slides ? 'Ui_ProjectFileSlideMany' : 'Ui_ProjectFilePageMany', String(file.pages)),
    );
  } else {
    parts.push(formatFileSize(file.sizeBytes));
  }
  if (file.truncated) parts.push(t('Ui_ProjectFileShortened'));
  return parts.join(' · ');
}

export interface ProjectFilesPanelProps {
  readonly files: readonly ProjectFileDto[];
  readonly pending: boolean;
  readonly problems: readonly FileProblem[];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (file: ProjectFileDto) => void;
  readonly onDismissProblem: (id: number) => void;
}

/** The files copied into the project: what each is, a way to take it out, and what went wrong. */
export function ProjectFilesPanel({
  files,
  pending,
  problems,
  disabled,
  onAdd,
  onRemove,
  onDismissProblem,
}: ProjectFilesPanelProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button size="sm" icon={Plus} disabled={disabled || pending} onClick={onAdd}>
          {t('Ui_ProjectFilesAdd')}
        </Button>
      </div>
      {files.length === 0 && !pending && problems.length === 0 ? (
        <p className="text-ui text-ink-muted">{t('Ui_ProjectFilesEmpty')}</p>
      ) : null}
      <ul className="flex flex-col">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex min-h-10 items-center gap-2 border-b border-hairline py-1.5 last:border-b-0"
          >
            <Icon icon={FileText} size={14} className="text-ink-muted" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui-lg text-ink" title={file.name}>
                {file.name}
              </span>
              <span className="tabular truncate font-mono text-caption text-ink-muted">
                {describeFile(file, t)}
              </span>
            </div>
            <IconButton
              label={t('Ui_ProjectFileRemove', file.name)}
              icon={X}
              size="sm"
              disabled={disabled}
              onClick={() => {
                onRemove(file);
              }}
            />
          </li>
        ))}
        {pending ? (
          <li
            role="status"
            aria-label={t('Ui_ProjectFileReading')}
            className="flex min-h-10 items-center gap-2 py-1.5"
          >
            <Skeleton className="h-3.5 w-1/2" />
            <span className="text-ui text-ink-muted">{t('Ui_ProjectFileReading')}</span>
          </li>
        ) : null}
        {problems.map((problem) => (
          <li
            key={problem.id}
            role="alert"
            className="flex min-h-10 items-start gap-2 border-b border-hairline py-1.5 last:border-b-0"
          >
            <Icon icon={CircleAlert} size={14} className="mt-[3px]" />
            <p className="min-w-0 flex-1 text-ui text-ink [overflow-wrap:anywhere]">
              {problem.name === '' ? '' : `${problem.name}: `}
              {t(FAILURE_KEYS[problem.reason])}
            </p>
            <IconButton
              label={t('Ui_ProjectFileDismissProblem')}
              icon={X}
              size="sm"
              tooltip={false}
              onClick={() => {
                onDismissProblem(problem.id);
              }}
            />
          </li>
        ))}
      </ul>
      <p className="text-caption text-ink-muted">{t('Ui_ProjectFilesNote')}</p>
    </div>
  );
}
