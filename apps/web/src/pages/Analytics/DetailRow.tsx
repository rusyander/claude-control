import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { DetailRowProps } from './DetailRow.types';
import styles from './AnalyticsPage.module.scss';

/** Строка «показатель — значение» в окне подробностей. */
export function DetailRow({ label, value, detail }: DetailRowProps) {
  return (
    <Stack
      direction="row"
      align="baseline"
      justify="between"
      gap="var(--spacing-sm)"
      className={styles.detailRow}
    >
      <Typography variant="body-sm" color="muted" as="span">
        {label}
      </Typography>
      <Stack align="end" gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" as="span">
          {value}
        </Typography>
        {detail && (
          <Typography variant="caption" color="subtle" as="span">
            {detail}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
