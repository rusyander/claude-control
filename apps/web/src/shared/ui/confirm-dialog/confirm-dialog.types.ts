export interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onConfirm: () => void;
  title: string;
  /** Что именно исчезнет и можно ли это вернуть. */
  description: string;
  /** Имя удаляемого объекта — его нужно ввести дословно для подтверждения. */
  confirmationName?: string;
  confirmLabel: string;
  isPending?: boolean;
}
