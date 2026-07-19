import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { HELP_ROUTE } from '@shared/config/routes';
import styles from './help-kit.module.scss';
import type { TopicNavProps } from './help-kit.types';

/**
 * Переход к соседнему разделу в конце документа. Справку читают не только
 * точечно: дочитавшему до конца проще пойти дальше, чем возвращаться в
 * оглавление и искать, что он уже смотрел.
 */
export function TopicNav({ prev, next, prevLabel, nextLabel }: TopicNavProps) {
  if (!prev && !next) return null;

  return (
    <Stack
      direction="row"
      justify="between"
      gap="var(--spacing-sm)"
      wrap
      className={styles.topicNav}
    >
      {prev ? (
        <Link to={HELP_ROUTE} search={{ topic: prev.id }} className={styles.navLink}>
          <Icon name="chevronLeft" size={24} />
          <Stack gap="var(--spacing-3xs)" minWidth={0}>
            <Typography variant="caption" color="subtle" as="span">
              {prevLabel}
            </Typography>
            <Typography variant="body-sm" weight="medium" as="span">
              {prev.title}
            </Typography>
          </Stack>
        </Link>
      ) : (
        <span />
      )}

      {next && (
        <Link
          to={HELP_ROUTE}
          search={{ topic: next.id }}
          className={`${styles.navLink} ${styles.navLinkNext}`}
        >
          <Stack gap="var(--spacing-3xs)" minWidth={0} align="end">
            <Typography variant="caption" color="subtle" as="span">
              {nextLabel}
            </Typography>
            <Typography variant="body-sm" weight="medium" as="span">
              {next.title}
            </Typography>
          </Stack>
          <Icon name="chevronRight" size={24} />
        </Link>
      )}
    </Stack>
  );
}
