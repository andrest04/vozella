import { CliSetupDialog } from './CliSetupDialog';
import { SetupWizardDialog } from './SetupWizardDialog';
import type { ProviderGate } from './use-provider-gate';

/** The dialogs of a provider gate. Put it once on a page that passes `gate.runSetup` down. */
export function ProviderGateDialogs({ gate }: { readonly gate: ProviderGate }) {
  const { open } = gate;
  return (
    <>
      <SetupWizardDialog
        open={open?.surface === 'wizard'}
        mode="local-only"
        onFinished={(result) => {
          gate.finish(result !== null);
        }}
      />
      <CliSetupDialog
        open={open?.surface === 'cli'}
        kind={open?.surface === 'cli' ? open.kind : 'ClaudeCode'}
        onFinished={gate.finish}
      />
    </>
  );
}

export { ProviderUnavailableNotice } from './ProviderUnavailableNotice';
