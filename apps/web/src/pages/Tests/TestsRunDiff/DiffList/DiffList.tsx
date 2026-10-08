import type { ProjectTestRunDiffCase } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import styles from './DiffList.module.scss';
import { STATUS_TONE } from '@entities/ProjectTest';

/** Один список сравнения. Пустой не рисуется: пять пустых заголовков — шум. */
export function DiffList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'danger' | 'success' | 'warning' | 'info' | 'neutral';
  items: ProjectTestRunDiffCase[];
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-2xs)" align="center">
        <Badge tone={tone}>{items.length}</Badge>
        <Typography variant="body-sm" weight="medium" as="span">
          {title}
        </Typography>
      </Stack>
      {items.map((item) => (
        <Stack
          key={`${item.groupId}:${item.caseId}`}
          direction="row"
          gap="var(--spacing-2xs)"
          align="center"
          wrap
          className={styles.failureRow}
        >
          <Typography variant="body-sm" as="span">
            {item.title ?? item.caseId}
          </Typography>
          {/* Переход показывается словами: «failed» без «из чего» не отличает
              новый провал от старого. */}
          <Typography variant="caption" color="subtle" as="span">
            {t('tests.diff.transition', {
              from: item.from ? t(`projectTests.status.${item.from}`) : t('tests.diff.missing'),
              to: item.to ? t(`projectTests.status.${item.to}`) : t('tests.diff.missing'),
            })}
          </Typography>
          {item.to && (
            <Badge tone={STATUS_TONE[item.to]}>{t(`projectTests.status.${item.to}`)}</Badge>
          )}
          {(item.flakyAttempts ?? 0) > 0 && (
            <Badge tone="warning">
              {t('tests.evidence.retryPass', { attempts: item.flakyAttempts })}
            </Badge>
          )}
          {item.note && (
            <Typography variant="caption" color="subtle" as="span">
              {item.note}
            </Typography>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
