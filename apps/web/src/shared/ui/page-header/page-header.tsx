import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { PageHeaderProps } from './page-header.types';

/** Шапка раздела: одинаковая структура на всех страницах. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
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
        <Typography variant="heading">{title}</Typography>
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
