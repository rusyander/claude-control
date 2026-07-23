import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import type { StatTileProps } from './StatTile.types';
import styles from './OverviewPage.module.scss';

/**
 * Плитка сводки: количество сущностей раздела, переход в него и быстрые действия.
 *
 * Основная область — ссылка в раздел; быстрые действия под ней — отдельные
 * ссылки-соседи, а не вложенные в основную (вложенные интерактивные элементы
 * недопустимы). Сами действия логики не несут: ведут в раздел с осмысленным
 * параметром (создать, открыть историю), а выполняет их уже целевая страница.
 */
export function StatTile({ icon, label, value, hint, tone, to, actions }: StatTileProps) {
  return (
    <Card padding="md" className={styles.tile}>
      <Stack gap="var(--spacing-xs)" className={styles.tileBody}>
        <Link to={to} className={styles.tileMain}>
          <Stack gap="var(--spacing-xs)">
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
              <Typography
                variant="caption"
                color={tone === 'danger' ? 'danger' : 'subtle'}
                as="span"
              >
                {hint}
              </Typography>
            )}
          </Stack>
        </Link>

        {actions && actions.length > 0 && (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.tileActions}>
            {actions.map((action) => (
              <Link
                key={action.label}
                to={action.to}
                search={action.search ?? {}}
                className={styles.tileAction}
              >
                {action.icon && <Icon name={action.icon} size={16} />}
                {action.label}
              </Link>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
