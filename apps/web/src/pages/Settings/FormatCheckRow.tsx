import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { stateTone } from './FormatCheckCard.lib';
import type { FormatCheckRowProps } from './FormatCheckRow.types';
import styles from './FormatCheckCard.module.scss';

/** Итог по одному CLI: состояние, ведомые ключи и пояснение. */
export function FormatCheckRow({ row, name }: FormatCheckRowProps) {
  const { t } = useTranslation();

  return (
    <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.row} wrap>
      <Badge tone={stateTone(row.state)}>{t(`formatCheck.state.${row.state}`)}</Badge>
      <Stack gap="var(--spacing-3xs)" className={styles.text}>
        <Typography variant="body-sm" as="span">
          {name}
        </Typography>
        {row.note && (
          <Typography variant="caption" color="subtle" as="span">
            {row.note}
          </Typography>
        )}
        {row.keys.map((key) => (
          <span key={key.path} className={styles.key}>
            {key.present
              ? t('formatCheck.keyPresent', { path: key.path })
              : t('formatCheck.keyMissing', { path: key.path })}
          </span>
        ))}
      </Stack>
    </Stack>
  );
}
