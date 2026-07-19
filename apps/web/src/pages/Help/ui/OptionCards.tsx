import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { OptionCardsProps } from './help-kit.types';

/**
 * Набор равнозначных вариантов: режимы создания, пресеты, вкладки, транспорты.
 * Сетка вместо списка не ради красоты — варианты выбирают сравнением, а
 * сравнивать удобнее рядом, а не одно под другим.
 */
export function OptionCards({ items, minWidth = 260 }: OptionCardsProps) {
  return (
    <div
      className={styles.optionGrid}
      style={{ '--option-min': `${minWidth}px` } as React.CSSProperties}
    >
      {items.map((item) => (
        <Card key={item.title} padding="md">
          <Stack gap="var(--spacing-2xs)">
            {item.badge && (
              <span>
                <Badge tone={item.badgeTone ?? 'neutral'}>{item.badge}</Badge>
              </span>
            )}
            <Typography variant="body-sm" weight="medium" as="span">
              {item.title}
            </Typography>
            <Typography variant="body-sm" color="muted" as="span">
              {item.text}
            </Typography>
          </Stack>
        </Card>
      ))}
    </div>
  );
}
