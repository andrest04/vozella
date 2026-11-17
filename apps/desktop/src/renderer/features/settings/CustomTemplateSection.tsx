import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button, SettingRow, Textarea } from '../../ui';

/**
 * The user's own note template: the instructions the summary follows when Custom is picked on the
 * Summary tab. Saving a blank text removes the template (and the option).
 */
export function CustomTemplateSection() {
  const t = useT();
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    window.vozella
      .invoke('settings.get', {})
      .then((settings) => {
        if (!alive.current) return;
        const current = settings.customNoteTemplate ?? '';
        setSaved(current);
        setText(current);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, []);

  const save = (): void => {
    const value = text.trim();
    window.vozella
      .invoke('settings.update', { patch: { customNoteTemplate: value === '' ? null : value } })
      .then((next) => {
        if (!alive.current) return;
        const current = next.customNoteTemplate ?? '';
        setSaved(current);
        setText(current);
        setJustSaved(true);
      })
      .catch(() => undefined);
  };

  return (
    <div data-testid="custom-template-section">
      <SettingRow
        title={t('Ui_CustomTemplateHeader')}
        description={t('Ui_CustomTemplateDescription')}
      >
        {() => (
          <div className="flex w-full flex-col items-start gap-2">
            <Textarea
              data-testid="CustomTemplateText"
              aria-label={t('Ui_CustomTemplateLabel')}
              placeholder={t('Ui_CustomTemplatePlaceholder')}
              rows={5}
              className="w-full"
              value={text}
              disabled={saved === null}
              onChange={(event) => {
                setText(event.currentTarget.value);
                setJustSaved(false);
              }}
            />
            <div className="flex items-center gap-3">
              <Button
                data-testid="SaveCustomTemplate"
                disabled={saved === null || text.trim() === saved.trim()}
                onClick={save}
              >
                {t('Ui_CustomTemplateSave')}
              </Button>
              <span role="status" className="text-ui text-ink-muted">
                {justSaved ? t('Ui_CustomTemplateSaved') : ''}
              </span>
            </div>
          </div>
        )}
      </SettingRow>
    </div>
  );
}
