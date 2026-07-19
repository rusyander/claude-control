import type { ReactNode } from 'react';
import styles from './button.module.scss';
import type { ButtonProps } from './button.types';

/** Единственная кнопка приложения: локальные button со своими стилями не заводим. */
export function Button(props: ButtonProps) {
  const {
    variant = 'secondary',
    size = 'md',
    fullWidth,
    isLoading,
    leftIcon,
    rightIcon,
    className,
    disabled,
    ...rest
  } = props as ButtonProps & {
    iconOnly?: boolean;
    icon?: ReactNode;
    children?: ReactNode;
  };

  const { iconOnly, icon, children, ...domProps } = rest;

  // У кнопки-иконки подпись есть только для скринридера. Дублируем её в title,
  // чтобы при наведении всплывала обычная подсказка — иначе смысл иконки
  // (например, «Песочница») угадать невозможно.
  const title =
    (domProps as { title?: string }).title ??
    (iconOnly ? (domProps as { 'aria-label'?: string })['aria-label'] : undefined);

  const classes = [
    styles.root,
    styles[variant],
    styles[size],
    fullWidth && styles.fullWidth,
    iconOnly && styles.iconOnly,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      // Во время загрузки кнопка недоступна: повторный клик отправит тот же
      // запрос ещё раз, а мы правим конфиги — дубли тут дорого стоят.
      disabled={disabled ?? isLoading}
      title={title}
      {...domProps}
    >
      {isLoading ? <span className={styles.spinner} aria-hidden="true" /> : leftIcon}
      {iconOnly ? icon : children}
      {!isLoading && rightIcon}
    </button>
  );
}
