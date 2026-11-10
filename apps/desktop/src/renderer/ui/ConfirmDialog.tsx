import { useRef } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  readonly description: string;
  readonly primaryLabel: string;
  readonly onConfirm: () => void;
}

/** A destructive confirmation. Cancel has the focus, so Enter never deletes by accident. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  closeLabel,
  primaryLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={closeLabel}
      initialFocus={cancelRef}
      actions={
        <>
          <Button
            ref={cancelRef}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {primaryLabel}
          </Button>
        </>
      }
    />
  );
}
