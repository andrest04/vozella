import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { SectionHeader, SettingRow, Switch } from '../../ui';

/**
 * The startup block of Settings: whether Windows opens Vozella at sign in. It reads the saved
 * value and never writes it back on first paint. A change patches only `openAtLogin`; the main
 * process writes the OS login item from that save; a settings file from before the option reads as
 * off there.
 */
export function StartupSection() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const settings = await window.vozella.invoke('settings.get', {});
      if (alive.current) setEnabled(settings.openAtLogin);
    } catch {
      // The toggle stays disabled until a read works.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  const change = (next: boolean): void => {
    setEnabled(next);
    window.vozella
      .invoke('settings.update', { patch: { openAtLogin: next } })
      .then(
        (saved) => {
          if (alive.current) setEnabled(saved.openAtLogin);
        },
        () => read(),
      )
      .catch(() => undefined);
  };

  return (
    <div data-testid="startup-section">
      <SectionHeader level={2} compact title={t('Ui_Startup')} className="pb-2" />
      <SettingRow title={t('Ui_OpenAtLogin')} description={t('Ui_OpenAtLoginDescription')}>
        {({ titleId }) => (
          <Switch
            id="ToggleOpenAtLogin"
            aria-labelledby={titleId}
            label={enabled ? t('Ui_SwitchOn') : t('Ui_SwitchOff')}
            checked={enabled ?? false}
            disabled={enabled === null}
            onCheckedChange={change}
          />
        )}
      </SettingRow>
    </div>
  );
}
