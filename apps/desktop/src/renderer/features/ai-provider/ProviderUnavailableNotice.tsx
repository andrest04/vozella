import { useT } from '../../i18n/I18nProvider';
import { Button, Notice } from '../../ui';
import { API_NAME_KEYS, apiSetupMessageKey } from './api-engines';
import type { ProviderGate } from './use-provider-gate';

/**
 * Shown after a removed provider (Grok) was selected, or when an API key engine still needs its
 * key or address: what to do, and a button to Settings.
 */
export function ProviderUnavailableNotice({ gate }: { readonly gate: ProviderGate }) {
  const t = useT();
  const { notice } = gate;
  if (!notice) return null;
  const text =
    notice.type === 'removed'
      ? t('Ui_SummaryProviderXaiRemoved')
      : t(apiSetupMessageKey(notice.reason), t(API_NAME_KEYS[notice.kind]));
  return (
    <Notice tone="warning" onDismiss={gate.dismissUnavailable} dismissLabel={t('Ui_Close')}>
      <p data-testid="TxtProviderUnavailable">{text}</p>
      <Button size="sm" className="mt-2" data-testid="BtnOpenSettings" onClick={gate.openSettings}>
        {t('Nav_Settings')}
      </Button>
    </Notice>
  );
}
