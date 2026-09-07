import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonBase extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  isLoading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
  /**
   * Ссылка на сам `<button>`. В React 19 это обычный проп, forwardRef не нужен:
   * кнопке, открывающей меню, ссылка на себя нужна, чтобы вернуть на неё фокус
   * после Escape.
   */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Кнопка либо с текстом, либо только с иконкой. Во втором случае aria-label
 * обязателен — иначе для скринридера это кнопка без названия. Разделение
 * через объединение типов не даёт забыть подпись на этапе компиляции.
 */
export type ButtonProps =
  | (ButtonBase & { children: ReactNode; iconOnly?: false; 'aria-label'?: string })
  | (ButtonBase & { children?: never; iconOnly: true; 'aria-label': string; icon: ReactNode });
