import { useCallback, useEffect, useRef, useState } from 'react';
import type { Translate } from '../../i18n/translate';
import { DRAFT_SUCCESS_MS, type DraftMessageState } from './use-summary-generation';

export interface ActionItemsExport {
  /** The result of the last export, shown like "Copy action items" (B16). */
  readonly message: DraftMessageState | null;
  readonly exporting: boolean;
  readonly exportIcs: (indexes: readonly number[]) => void;
  /** Drops the message, when another one takes its place. */
  readonly clear: () => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * "Add to calendar (.ics)": main builds the file and asks where to save it. A cancelled dialog
 * says nothing; a success goes away by itself, an error stays until the next action.
 */
export function useActionItemsExport(meetingId: string | null, t: Translate): ActionItemsExport {
  const [message, setMessage] = useState<DraftMessageState | null>(null);
  const [exporting, setExporting] = useState(false);
  const idRef = useRef(meetingId);
  idRef.current = meetingId;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    setMessage(null);
  }, [meetingId]);

  useEffect(() => {
    if (message?.kind !== 'success') return undefined;
    const timer = setTimeout(() => {
      setMessage(null);
    }, DRAFT_SUCCESS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [message]);

  const exportIcs = useCallback((indexes: readonly number[]) => {
    const id = idRef.current;
    if (id === null) return;
    const tr = tRef.current;
    setMessage(null);
    setExporting(true);
    void (async () => {
      let next: DraftMessageState | null;
      try {
        const answer = await window.vozella.invoke('summaries.exportActionItemsIcs', {
          meetingId: id,
          indexes: [...indexes],
        });
        switch (answer.status) {
          case 'exported':
            next = {
              kind: 'success',
              text:
                answer.count === 1
                  ? tr('Ui_ActionItemsExportedOne')
                  : tr('Ui_ActionItemsExported', answer.count),
            };
            break;
          case 'empty':
            next = { kind: 'error', text: tr('Ui_ActionItemsExportEmpty') };
            break;
          case 'failed':
            next = { kind: 'error', text: tr('Ui_ActionItemsExportFailed', answer.message) };
            break;
          default:
            next = null;
        }
      } catch (error) {
        next = { kind: 'error', text: tr('Ui_ActionItemsExportFailed', errorText(error)) };
      }
      setExporting(false);
      if (idRef.current === id) setMessage(next);
    })();
  }, []);

  const clear = useCallback(() => {
    setMessage(null);
  }, []);

  return { message, exporting, exportIcs, clear };
}
