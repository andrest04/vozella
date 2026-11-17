import type { RecordingSetupDto } from '@vozella/contracts';
import { useT } from '../../i18n/I18nProvider';
import { Button, Dialog } from '../../ui';
import { needsCloudKey } from './needs-cloud-key';
import { SetupCards } from './SetupCards';

/**
 * The modal of the same checklist (spec 2.4b), opened by Record or Import when something is
 * missing. "Set up" runs the missing steps; "Cancel", Escape and the close button all decline. The
 * "Done" state of the earlier dialog is never reachable there (B-17), so it is not drawn.
 *
 * With a cloud transcription engine that has no key, the step is not an install: the dialog says
 * which key is missing and its one action reads "Add API key" (it opens Settings on the field).
 */
export function SetupDialog({
  setup,
  onAnswer,
}: {
  /** Null keeps the dialog closed. */
  readonly setup: RecordingSetupDto | null;
  readonly onAnswer: (answer: 'setup' | 'cancel') => void;
}) {
  const t = useT();
  // The provider's name, when the missing step is the API key of a cloud transcription engine.
  const cloudKey = setup !== null && needsCloudKey(setup) ? setup.engine.detail.args : null;
  return (
    <Dialog
      open={setup !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer('cancel');
      }}
      title={t('RecordingSetup.Title')}
      description={
        cloudKey ? t('Ui_SetupCloudKeyHeadline', ...cloudKey) : t('RecordingSetup_Headline.Text')
      }
      closeLabel={t('Ui_Close')}
      actions={
        <>
          <Button
            onClick={() => {
              onAnswer('cancel');
            }}
          >
            {t('RecordingSetup.CloseButtonText')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onAnswer('setup');
            }}
          >
            {cloudKey ? t('Ui_SetupAddKey') : t('RecordingSetup_SetUp')}
          </Button>
        </>
      }
    >
      {setup ? <SetupCards setup={setup} /> : null}
    </Dialog>
  );
}
