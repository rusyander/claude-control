import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import type { StatTileProps } from './StatTile.types';
import styles from './OverviewPage.module.scss';

/** Плитка сводки: количество сущностей раздела и переход в него. */
export function StatTile({ icon, label, value, hint, tone, to }: StatTileProps) {
  return (
    <Link to={to} className={styles.tileLink}>
      <Card isInteractive padding="md">
        <Stack gap="var(--spacing-xs)" className={styles.tileBody}>
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name={icon} size={24} />
            <Typography variant="body-sm" color="muted" as="span">
              {label}
            </Typography>
          </Stack>
          <Typography variant="heading-lg" as="span">
            {value}
          </Typography>
          {hint && (
            <Typography variant="caption" color={tone === 'danger' ? 'danger' : 'subtle'} as="span">
              {hint}
            </Typography>
          )}
        </Stack>
      </Card>
    </Link>
  );
}
