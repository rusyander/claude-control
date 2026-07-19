import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { HELP_ROUTE } from '@shared/config/routes';
import styles from './page-header.module.scss';
import type { PageHeaderProps } from './page-header.types';

/** Шапка раздела: одинаковая структура на всех страницах. */
export function PageHeader({ title, subtitle, actions, helpTopic }: PageHeaderProps) {
  const { t } = useTranslation();

  return (
    <Stack
      direction="row"
      align="start"
      justify="between"
      gap="var(--spacing-md)"
      wrap
      marginTop={0}
    >
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Typography variant="heading">{title}</Typography>

          {helpTopic && (
            <Link
              to={HELP_ROUTE}
              search={{ topic: helpTopic }}
              className={styles.help}
              title={t('help.common.openHelp')}
              aria-label={t('help.common.openHelp')}
            >
              <Icon name="help" size={24} />
            </Link>
          )}
        </Stack>

        {subtitle && (
          <Typography variant="body-sm" color="muted">
            {subtitle}
          </Typography>
        )}
      </Stack>
      {actions && (
        <Stack direction="row" gap="var(--spacing-xs)">
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
