export interface DeleteButtonProps {
  /** Имя объекта: показывается в диалоге и его нужно ввести для подтверждения. */
  entityName: string;
  /** Что именно произойдёт и можно ли это откатить. */
  description: string;
  onDelete: () => void;
  isPending?: boolean;
}
