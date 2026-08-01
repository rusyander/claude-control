import styles from './tab-button.module.scss';
import type { TabButtonProps } from './tab-button.types';

/**
 * Вкладка-переключатель внутри карточки или модального окна: обычная кнопка,
 * подсвеченная акцентом, когда её раздел открыт. Полосу вкладок (`display:
 * flex`, отступы, нижняя граница) рисует вызывающая сторона — она у каждого
 * места своя, общая здесь только сама кнопка.
 */
export function TabButton({ isActive, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
