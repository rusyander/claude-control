import type { StepHintProps } from './StepHint.types';
import styles from './StepHint.module.scss';

/**
 * Подсказка строки порядка работы: описание шага, пока на строку наведена мышь
 * или на неё встал фокус. Сама подсказка — часть той же обёртки, что и кнопка,
 * поэтому указатель можно перевести на неё и прочитать, не потеряв её (WCAG
 * 1.4.13). Текст лежит в разметке и у скрытой подсказки — им кнопка описана
 * для диктора; сводку ресурса строка кладёт сюда только показанной.
 */
export function StepHint({ id, isShown, children }: StepHintProps) {
  return (
    <span role="tooltip" id={id} hidden={!isShown} className={styles.hint}>
      {children}
    </span>
  );
}
