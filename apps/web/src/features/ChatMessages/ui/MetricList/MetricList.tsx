import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import type { MetricListProps } from './MetricList.types';
import styles from './MetricList.module.scss';

/**
 * Числа карточки группы колонками: подпись тихо над значением, значение —
 * ровными цифрами (владелец 22.10.2026: строки через запятую «первый запрос
 * 71 тыс., в среднем 132 тыс. в окне, …» читались слитно, число приходилось
 * выискивать в прозе). Колонки переносятся целиком, а не по буквам.
 * Только строчные и списочные элементы без действий: список лежит под
 * растянутой кнопкой, открывающей чат группы.
 */
export function MetricList({ items, attr, className }: MetricListProps) {
  if (items.length === 0) return null;
  return (
    <dl className={cn(styles.list, className)} {...{ [attr]: '' }}>
      {items.map((item) => (
        <div key={item.key} className={styles.cell} {...{ [`${attr}-cell`]: item.key }}>
          <Typography variant="caption" color="subtle" as="dt">
            {item.label}
          </Typography>
          <Typography variant="body-sm" weight="medium" as="dd" className={styles.value}>
            {item.value}
            {item.hint && (
              <Typography variant="caption" color="subtle" as="span" className={styles.hint}>
                {item.hint}
              </Typography>
            )}
          </Typography>
        </div>
      ))}
    </dl>
  );
}
