import type { ProjectLocalSectionProps } from '../ProjectLocalConfigView.types';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import styles from './Section.module.scss';

/** Заголовок раздела со счётчиком; пустой раздел — одной строкой вместо списка. */
export function Section({ title, count, empty, children }: ProjectLocalSectionProps) {
  return (
    <Stack gap="var(--spacing-2xs)" as="section" aria-label={title}>
      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Typography variant="body-sm" weight="semibold" as="span">
          {title}
        </Typography>
        <Badge tone={count > 0 ? 'accent' : 'neutral'}>{count}</Badge>
      </Stack>
      {count === 0 ? (
        <Typography variant="caption" color="subtle">
          {empty}
        </Typography>
      ) : (
        <ul className={styles.list}>{children}</ul>
      )}
    </Stack>
  );
}
