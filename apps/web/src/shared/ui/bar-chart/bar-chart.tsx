import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { Button } from '@shared/ui/button';
import styles from './bar-chart.module.scss';
import type { BarChartProps } from './bar-chart.types';

/**
 * Горизонтальные полосы для сравнения величин по категориям. Подписи значений
 * выводятся текстом всегда: часть цветов серий в светлой теме не даёт нужного
 * контраста к фону, и по правилам доступности одного цвета мало.
 *
 * Длинный хвост по умолчанию свёрнут в одну строку, но раскрывается целиком:
 * прятать данные насовсем нельзя, а показывать сотню строк сразу — бесполезно.
 */
export function BarChart({ items, limit = 8, otherLabel, formatValue, onItemClick }: BarChartProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  const restLabel = otherLabel ?? t('common.other');
  const visible = isExpanded ? items : items.slice(0, limit);
  const rest = isExpanded ? [] : items.slice(limit);

  // Строка «Прочее» — сумма хвоста в единицах колонки: число свёрнутых строк
  // и так стоит на кнопке «Показать все», а колонка значений одна на всех.
  const restValue = rest.reduce((sum, item) => sum + item.value, 0);
  const rows = rest.length
    ? [
        ...visible,
        {
          id: '__other__',
          label: restLabel,
          value: restValue,
          valueLabel: formatValue ? formatValue(restValue) : String(restValue),
          seriesIndex: 0,
        },
      ]
    : visible;

  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <div className={styles.root}>
      {rows.map((row) => {
        const isClickable = Boolean(onItemClick) && row.id !== '__other__';

        return (
          <div
            key={row.id}
            className={[styles.row, isClickable && styles.clickable].filter(Boolean).join(' ')}
            onClick={isClickable ? () => onItemClick?.(row.id) : undefined}
            onKeyDown={
              isClickable
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') onItemClick?.(row.id);
                  }
                : undefined
            }
            role={isClickable ? 'button' : undefined}
            tabIndex={isClickable ? 0 : undefined}
          >
            <TruncatedText
              text={row.label}
              variant="body-sm"
              color="muted"
              className={styles.label}
            />

            <div className={styles.track}>
              <div
                className={styles.fill}
                style={{
                  width: `${Math.max((row.value / max) * 100, 1.5)}%`,
                  backgroundColor: `var(--series-${(row.seriesIndex ?? 0) % 5 || 5})`,
                }}
              />
            </div>

            <Typography variant="body-sm" as="span" className={styles.value}>
              {row.valueLabel}
            </Typography>
          </div>
        );
      })}

      {items.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? t('common.showLess') : t('common.showAll', { count: items.length })}
        </Button>
      )}
    </div>
  );
}
