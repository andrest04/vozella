import { Plus } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useT } from '../../i18n/I18nProvider';
import { Button, Field, Input, Popover, Textarea } from '../../ui';
import { createProject, failureKey } from './use-projects';

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

/**
 * New project, in a popover under its button: a name (required) and a description (optional).
 * Enter creates it, Escape closes. The errors are words with an icon, next to the field.
 */
export function NewProjectPopover({ disabled }: { readonly disabled: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setError(null);
      setNameError(null);
    }
  }, [open]);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === '') {
      setNameError(t('Ui_ProjectNameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setNameError(null);
    const result = await createProject(name, description);
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      void navigate({ to: '/projects/$projectId', params: { projectId: result.project.id } });
      return;
    }
    const key = failureKey(result.reason);
    if (
      key === 'Ui_ProjectNameRequired' ||
      key === 'Ui_ProjectNameTaken' ||
      key === 'Ui_ProjectNameTooLong'
    ) {
      setNameError(t(key));
    } else {
      setError(t(key, result.message ?? result.reason));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('Ui_ProjectsNew')}
      align="end"
      className="w-80 p-4"
      trigger={
        <Button variant="primary" icon={Plus} disabled={disabled}>
          {t('Ui_ProjectsNew')}
        </Button>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-3"
      >
        <Field label={t('Ui_ProjectName')} error={nameError ?? undefined}>
          <Input
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        </Field>
        <Field label={t('Ui_ProjectDescriptionOptional')}>
          <Textarea
            rows={2}
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-ui text-ink">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('Ui_Cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('Ui_ProjectCreate')}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
