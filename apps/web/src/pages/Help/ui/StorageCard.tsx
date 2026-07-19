import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import styles from './help-kit.module.scss';
import type { StorageCardProps } from './help-kit.types';

/**
 * «Где это физически лежит» — блок, который снимает больше всего вопросов.
 * Своей базы у приложения нет: всё, что видно на странице, это файл на диске,
 * и путь к нему стоит показать раньше любых объяснений.
 */
export function StorageCard({ title, rows }: StorageCardProps) {
  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="folder" size={24} className={styles.storageIcon} />
          <Typography variant="body-sm" weight="medium" as="span">
            {title}
          </Typography>
        </Stack>

        <dl className={styles.storageList}>
          {rows.map((row) => (
            <div key={row.label} className={styles.storageRow}>
              <Typography variant="body-sm" color="muted" as="dt" className={styles.storageLabel}>
                {row.label}
              </Typography>
              <Typography
                variant={row.isMono ? 'mono' : 'body-sm'}
                as="dd"
                className={styles.storageValue}
              >
                {row.value}
              </Typography>
            </div>
          ))}
        </dl>
      </Stack>
    </Card>
  );
}
