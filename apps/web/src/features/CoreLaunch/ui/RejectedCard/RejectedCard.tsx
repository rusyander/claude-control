import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { RejectedRow } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';

interface RejectedCardProps {
  rows: RejectedRow[];
}

/**
 * Правки сценария, которые ядро отвергло (06: репозиторий не расширяет суженное человеком или
 * ядром). Блок виден всегда — и пустым: «ничего не отвергнуто» тоже ответ, а пропавший блок
 * не отличить от непрочитанного.
 */
export function RejectedCard({ rows }: RejectedCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.rejected';
  return (
    <LaunchSection title={t(`${P}.heading`)} hint={t(`${P}.hint`)} name="rejected">
      <Stack gap="var(--spacing-xs)" data-rejected-count={rows.length}>
        {rows.length === 0 && (
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.empty`)}
          </Typography>
        )}
        {rows.map((row) => (
          <div
            key={`${row.level}:${row.path}:${row.value}`}
            className={`${styles.row} ${styles.rowWarn}`}
            data-rejected-path={row.path}
          >
            <Stack gap="var(--spacing-3xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Badge tone="warning">{t(`${P}.level`, { level: row.level })}</Badge>
                <Typography variant="body-sm" weight="medium" as="span" className={styles.mono}>
                  {row.path} = {row.value}
                </Typography>
              </Stack>
              {row.reason && (
                <Typography variant="caption" color="muted" as="p">
                  {row.reason}
                </Typography>
              )}
            </Stack>
          </div>
        ))}
      </Stack>
    </LaunchSection>
  );
}
