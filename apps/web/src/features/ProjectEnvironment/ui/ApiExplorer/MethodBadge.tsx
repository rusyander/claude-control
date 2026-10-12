import type { ApiMethod } from '@entities/ApiExplorer';
import styles from './ApiExplorer.module.scss';

/**
 * Метод HTTP цветом, как в любом клиенте API: GET спокойный, DELETE тревожный.
 * Цвет — подсказка, не единственный знак: слово метода написано всегда.
 */
export function MethodBadge({ method }: { method: ApiMethod }) {
  return (
    <span className={styles.method} data-method={method}>
      {method.toUpperCase()}
    </span>
  );
}
