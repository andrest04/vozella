import type { MeetingListItemDto } from '@vozella/contracts';
import { useEffect, useRef, useState } from 'react';
import type { StringKey, Translate } from '../../i18n/translate';
import { clearFolderRequest, useLibraryStore, type FolderRequest } from './library-store';
import type { StatusMessage } from './use-library';

export type DialogState =
  | { readonly kind: 'newFolder' }
  | { readonly kind: 'rename'; readonly folderId: string; readonly name: string }
  | { readonly kind: 'personality'; readonly folderId: string }
  | { readonly kind: 'deleteFolder'; readonly folderId: string; readonly name: string }
  | { readonly kind: 'move'; readonly meeting: MeetingListItemDto }
  | { readonly kind: 'deleteMeeting'; readonly meeting: MeetingListItemDto }
  /** `refused`: the Recycle Bin said no. Otherwise it was asked for directly, with Shift+Delete. */
  | {
      readonly kind: 'deleteMeetingPermanently';
      readonly meeting: MeetingListItemDto;
      readonly refused: boolean;
    }
  | { readonly kind: 'moveMany'; readonly meetings: readonly MeetingListItemDto[] }
  | { readonly kind: 'deleteMany'; readonly meetingIds: readonly string[] }
  | {
      readonly kind: 'deleteManyPermanently';
      readonly meetingIds: readonly string[];
      readonly refused: boolean;
    }
  | { readonly kind: 'renameMeeting'; readonly meeting: MeetingListItemDto };

type ConfirmKind =
  | 'deleteFolder'
  | 'deleteMany'
  | 'deleteManyPermanently'
  | 'deleteMeeting'
  | 'deleteMeetingPermanently';

/** The dialogs that only ask yes or no: one `ConfirmDialog` shows each of them. */
export type ConfirmDialogState = Extract<DialogState, { readonly kind: ConfirmKind }>;

/** What a confirmation says: catalog keys, with the placeholder values the dialog fills in. */
export interface ConfirmText {
  readonly title: StatusMessage;
  readonly description: StatusMessage;
  readonly cancel: StringKey;
  readonly primary: StringKey;
}

const message = (key: StringKey, ...args: string[]): StatusMessage => ({ key, args });

const CONFIRM_TEXT: {
  readonly [K in ConfirmKind]: (dialog: Extract<DialogState, { readonly kind: K }>) => ConfirmText;
} = {
  deleteFolder: (dialog) => ({
    title: message('LibraryDeleteFolder_Title'),
    description: message('LibraryDeleteFolder_Content', dialog.name),
    cancel: 'LibraryDeleteFolder_Cancel',
    primary: 'LibraryDeleteFolder_Primary',
  }),
  deleteMany: (dialog) => ({
    title: message('Ui_LibraryDeleteManyTitle', String(dialog.meetingIds.length)),
    description: message('Ui_LibraryDeleteManyContent'),
    cancel: 'HistoryDelete_Cancel',
    primary: 'HistoryDelete_Primary',
  }),
  deleteManyPermanently: (dialog) => ({
    title: message('Ui_LibraryDeletePermanentTitle'),
    description: message(
      dialog.refused ? 'Ui_LibraryDeleteManyRefused' : 'Ui_LibraryDeleteManyPermanent',
      String(dialog.meetingIds.length),
    ),
    cancel: 'HistoryDelete_Cancel',
    primary: 'Ui_LibraryDeletePermanentPrimary',
  }),
  deleteMeeting: (dialog) => ({
    title: message('HistoryDelete_Title'),
    description: message('Ui_LibraryDeleteContent', dialog.meeting.title),
    cancel: 'HistoryDelete_Cancel',
    primary: 'HistoryDelete_Primary',
  }),
  deleteMeetingPermanently: (dialog) => ({
    title: message('Ui_LibraryDeletePermanentTitle'),
    description: message(
      dialog.refused ? 'Ui_LibraryDeletePermanentContent' : 'Ui_LibraryDeletePermanentDirect',
      dialog.meeting.title,
    ),
    cancel: 'HistoryDelete_Cancel',
    primary: 'Ui_LibraryDeletePermanentPrimary',
  }),
};

export const isConfirmDialog = (dialog: DialogState): dialog is ConfirmDialogState =>
  dialog.kind in CONFIRM_TEXT;

export function confirmText(dialog: ConfirmDialogState): ConfirmText {
  // TypeScript cannot pair the kind with its entry across the union, so the lookup is widened.
  const describe = CONFIRM_TEXT[dialog.kind] as (dialog: ConfirmDialogState) => ConfirmText;
  return describe(dialog);
}

interface FolderLookup {
  readonly folderName: (id: string) => string;
  readonly canDeleteFolder: (id: string) => boolean;
  readonly showStatus: (message: StatusMessage) => void;
}

/**
 * Which Library dialog is open, plus the last one shown so a closing dialog keeps its text while it
 * fades. Folder actions the sidebar leaves in the store open here, also from another screen.
 */
export function useLibraryDialogs({ folderName, canDeleteFolder, showStatus }: FolderLookup) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const runFolderAction = (request: FolderRequest): void => {
    if (request.kind === 'new') setDialog({ kind: 'newFolder' });
    else if (request.kind === 'rename') {
      setDialog({ kind: 'rename', folderId: request.folderId, name: folderName(request.folderId) });
    } else if (request.kind === 'personality') {
      setDialog({ kind: 'personality', folderId: request.folderId });
    } else if (canDeleteFolder(request.folderId)) {
      setDialog({
        kind: 'deleteFolder',
        folderId: request.folderId,
        name: folderName(request.folderId),
      });
    } else {
      showStatus({ key: 'LibraryDeleteFolder_NotEmpty', args: [] });
    }
  };

  // The sidebar cannot open dialogs: it leaves the request here, also from another screen.
  const folderRequest = useLibraryStore((state) => state.folderRequest);
  const runRequest = useRef(runFolderAction);
  runRequest.current = runFolderAction;
  useEffect(() => {
    if (!folderRequest) return;
    clearFolderRequest();
    runRequest.current(folderRequest);
  }, [folderRequest]);

  // Keep the last dialog's data while it fades out, so its text does not blank first.
  const lastDialog = useRef(dialog);
  if (dialog) lastDialog.current = dialog;
  const lastConfirm = useRef<ConfirmDialogState | null>(null);
  if (dialog && isConfirmDialog(dialog)) lastConfirm.current = dialog;

  return {
    dialog,
    /** The open dialog, or the one still fading out. */
    shown: dialog ?? lastDialog.current,
    /** The open confirmation, or the last one, for the single `ConfirmDialog`. */
    confirm: lastConfirm.current,
    confirmOpen: dialog !== null && isConfirmDialog(dialog),
    openDialog: setDialog,
    closeDialog: (): void => {
      setDialog(null);
    },
    runFolderAction,
  };
}

/** The rename-meeting dialog's request: busy while it runs, and why it failed when it does. */
export function useMeetingRename({
  t,
  refresh,
  onRenamed,
}: {
  readonly t: Translate;
  readonly refresh: () => Promise<void>;
  readonly onRenamed: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rename = async (id: string, title: string): Promise<void> => {
    setBusy(true);
    try {
      const { status } = await window.vozella.invoke('session.rename', { id, title });
      if (status === 'blocked') {
        setProblem(t('Ui_SessionRenameBlockedText'));
        return;
      }
      // This channel does not announce a change, so the list asks for itself.
      await refresh();
      onRenamed();
    } catch (error) {
      setProblem(t('Ui_SessionRenameFailedText', error instanceof Error ? error.message : ''));
    } finally {
      setBusy(false);
    }
  };
  return {
    problem,
    busy,
    rename,
    clearProblem: (): void => {
      setProblem(null);
    },
  };
}
