export interface DeleteButtonProps {
  /** Имя объекта: показывается в диалоге и его нужно ввести для подтверждения. */
  entityName: string;
  /**
   * Что вводить для подтверждения, если имя объекта не набрать с клавиатуры
   * (у хука в нём «·» и «|»). По умолчанию — само имя.
   */
  confirmationName?: string;
  /** Что именно произойдёт и можно ли это откатить. */
  description: string;
  onDelete: () => void;
  isPending?: boolean;
}
