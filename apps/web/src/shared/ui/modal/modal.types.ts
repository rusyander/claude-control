import type { ReactNode } from 'react';

export interface ModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Кнопки внизу окна: сохранить, отменить, удалить. */
  footer?: ReactNode;
  /**
   * xl — для форм с помощником: поля и чат в две колонки. full — рабочее окно
   * почти во весь экран: дерево файлов и редактор.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /**
   * Отдать телу окна всю высоту и запретить ему прокрутку.
   *
   * Нужно окнам, внутри которых прокручиваются собственные области: без этого
   * прокрутка получается двойной — сначала едет всё окно вместе с шапкой, и
   * только потом содержимое колонки, до которой добрались.
   */
  bodyFill?: boolean;
}
