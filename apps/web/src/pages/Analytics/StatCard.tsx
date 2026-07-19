import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import type { StatCardProps } from './StatCard.types';

/**
 * Одно число крупно. Для единичной величины это честнее графика: рисовать
 * столбик из одного значения нечего, а цифра читается мгновенно.
 */
export function StatCard({ label, value, hint, detail }: StatCardProps) {
  return (
    <Card padding="md" title={hint}>
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" color="muted" as="span">
          {label}
        </Typography>
        <Typography variant="heading" as="span">
          {value}
        </Typography>
        {detail && (
          <Typography variant="caption" color="subtle" as="span">
            {detail}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
