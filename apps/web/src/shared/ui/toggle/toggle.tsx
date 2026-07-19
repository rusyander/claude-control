import { Root, Thumb } from '@radix-ui/react-switch';
import styles from './toggle.module.scss';
import type { ToggleProps } from './toggle.types';

/**
 * Переключатель включения сущности. Построен на Radix: клавиатура, роли и
 * состояния уже реализованы правильно, нам остаются только стили по токенам.
 */
export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  size = 'md',
  'aria-label': ariaLabel,
}: ToggleProps) {
  return (
    <Root
      className={[styles.root, styles[size]].join(' ')}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <Thumb className={styles.thumb} />
    </Root>
  );
}
