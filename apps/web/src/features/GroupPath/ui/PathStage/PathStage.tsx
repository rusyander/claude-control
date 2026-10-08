import type { PathStageProps } from './PathStage.types';
import styles from './PathStage.module.scss';

/**
 * Стадия конвейера — тонкий разделитель, а не шаг: она есть у каждой группы,
 * не правится и не должна спорить за внимание со своими шагами. Щелчок по
 * названию открывает окно стадии, подсказка — что на ней происходит.
 */
export function PathStage({ title, hint, onOpen }: PathStageProps) {
  return (
    <li className={styles.stage}>
      <span className={styles.line} />
      <button type="button" className={styles.label} title={hint} onClick={onOpen}>
        {title}
      </button>
      <span className={styles.line} />
    </li>
  );
}
